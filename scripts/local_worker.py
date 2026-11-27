#!/usr/bin/env python3
"""
OMega Zero-Port Local Inference Worker (stdio JSON-lines)
---------------------------------------------------------
Runs local Hugging Face .safetensors models directly over stdin/stdout pipes
with ZERO HTTP ports and automatic hardware adaptation on any machine:
  - High-VRAM CUDA GPU -> native fp16/bf16 on GPU
  - Entry/Mid CUDA GPU -> 4-bit quantization (if bitsandbytes installed) or auto GPU+RAM offload
  - Apple Silicon (MPS) -> Metal GPU acceleration
  - CPU-only PC -> multi-threaded CPU execution
"""

import gc
import json
import os
import sys
import threading
from typing import Any, Dict, List, Optional

STATE: Dict[str, Any] = {
    "model": None,
    "tokenizer": None,
    "model_dir": "",
    "model_id": "",
    "device_desc": "cpu",
}


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def get_weight_size_gb(model_dir: str) -> float:
    total = 0
    try:
        for name in os.listdir(model_dir):
            if name.endswith(".safetensors") or name.endswith(".bin"):
                total += os.path.getsize(os.path.join(model_dir, name))
    except OSError:
        pass
    return round(total / (1024 ** 3), 2)


def detect_runtime_hardware() -> Dict[str, Any]:
    import torch

    logical_cores = os.cpu_count() or 4
    physical_cores = logical_cores
    try:
        import psutil

        physical_cores = psutil.cpu_count(logical=False) or max(1, logical_cores // 2)
    except Exception:
        physical_cores = max(1, logical_cores // 2)

    info: Dict[str, Any] = {
        "backend": "cpu",
        "cuda": False,
        "mps": False,
        "vram_gb": 0.0,
        "gpu_count": 0,
        "cpu_threads": physical_cores,
        "logical_cores": logical_cores,
    }
    if torch.cuda.is_available():
        gpu_count = torch.cuda.device_count()
        total_vram = sum(
            torch.cuda.get_device_properties(i).total_memory for i in range(gpu_count)
        )
        info["backend"] = "cuda"
        info["cuda"] = True
        info["gpu_count"] = gpu_count
        info["vram_gb"] = round(total_vram / (1024 ** 3), 2)
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        info["backend"] = "mps"
        info["mps"] = True
    return info


def load_model(model_dir: str, model_id: str, req_id: str) -> None:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    abs_dir = os.path.abspath(model_dir)
    if STATE["model"] is not None and STATE["model_dir"] == abs_dir:
        return

    if STATE["model"] is not None:
        STATE["model"] = None
        STATE["tokenizer"] = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    hw = detect_runtime_hardware()
    weight_gb = get_weight_size_gb(abs_dir)
    offload_dir = os.path.join(os.getcwd(), "offload_cache")
    os.makedirs(offload_dir, exist_ok=True)

    load_kwargs: Dict[str, Any] = {
        "low_cpu_mem_usage": True,
        "trust_remote_code": True,
    }

    device_desc = f"CPU ({hw['cpu_threads']} threads)"
    use_mps = False

    if hw["cuda"]:
        vram_gb = hw["vram_gb"]
        if weight_gb > 0 and vram_gb >= weight_gb * 1.25:
            load_kwargs["dtype"] = "auto"
            load_kwargs["device_map"] = "auto"
            device_desc = f"CUDA GPU ({vram_gb} GB VRAM, full precision)"
        else:
            # Try 4-bit quantization when VRAM is smaller than full weights
            bnb_available = False
            try:
                import bitsandbytes  # noqa: F401
                bnb_available = True
            except Exception:
                bnb_available = False

            if bnb_available and vram_gb >= 3.5:
                from transformers import BitsAndBytesConfig

                load_kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.float16,
                    bnb_4bit_use_double_quant=True,
                )
                load_kwargs["device_map"] = "auto"
                load_kwargs["offload_folder"] = offload_dir
                device_desc = f"CUDA GPU ({vram_gb} GB VRAM, 4-bit NF4)"
            elif vram_gb >= 3.5:
                load_kwargs["dtype"] = torch.float16
                load_kwargs["device_map"] = "auto"
                load_kwargs["offload_folder"] = offload_dir
                device_desc = f"CUDA GPU + RAM offload ({vram_gb} GB VRAM)"
            else:
                load_kwargs["dtype"] = torch.float32
                device_desc = f"CPU ({hw['cpu_threads']} threads; GPU VRAM {vram_gb} GB too small)"
    elif hw["mps"]:
        load_kwargs["dtype"] = torch.float16
        use_mps = True
        device_desc = "Apple Silicon MPS"
    else:
        torch.set_num_threads(max(1, hw["cpu_threads"]))
        load_kwargs["dtype"] = "auto"
        device_desc = f"CPU ({hw['cpu_threads']} physical cores)"

    emit({"id": req_id, "type": "status", "message": f"Loading '{model_id}' on {device_desc}..."})

    tokenizer = AutoTokenizer.from_pretrained(abs_dir, trust_remote_code=True)
    try:
        model = AutoModelForCausalLM.from_pretrained(abs_dir, **load_kwargs)
    except ValueError:
        from transformers import AutoModelForImageTextToText

        model = AutoModelForImageTextToText.from_pretrained(abs_dir, **load_kwargs)

    if use_mps:
        model = model.to("mps")

    model.eval()
    STATE["model"] = model
    STATE["tokenizer"] = tokenizer
    STATE["model_dir"] = abs_dir
    STATE["model_id"] = model_id
    STATE["device_desc"] = device_desc
    STATE["is_cpu"] = not (hw["cuda"] or hw["mps"])


def extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p)
    return str(content or "")


def _compact_dynamic_context(text: str, max_ctx_chars: int = 500) -> str:
    """On CPU-only machines, cap the [Dynamic Context] block so prefill stays fast while keeping key context."""
    if not text.startswith("[Dynamic Context]\n"):
        return text
    idx = text.rfind("\n\n")
    if idx == -1 or idx + 2 >= len(text):
        return text
    ctx_block = text[:idx]
    user_part = text[idx + 2 :].strip()
    if len(ctx_block) <= max_ctx_chars:
        return text
    return f"{ctx_block[:max_ctx_chars].rstrip()}...\n\n{user_part}"


def normalize_messages(raw_messages: List[Dict[str, Any]], compact_for_cpu: bool = False) -> List[Dict[str, str]]:
    sys_msg = None
    turns: List[Dict[str, str]] = []
    for m in raw_messages:
        role = str(m.get("role", "user"))
        text = extract_text(m.get("content", "")).strip()
        if not text:
            continue
        if role == "system":
            if sys_msg is None:
                if compact_for_cpu and len(text) > 320:
                    text = text[:320].rstrip() + "..."
                sys_msg = {"role": "system", "content": text}
            continue
        if role not in ("user", "assistant"):
            role = "user"
        if compact_for_cpu and role == "user":
            text = _compact_dynamic_context(text, max_ctx_chars=500)
        if not turns:
            if role != "user":
                continue
            turns.append({"role": "user", "content": text})
        elif turns[-1]["role"] == role:
            turns[-1]["content"] += "\n\n" + text
        else:
            turns.append({"role": role, "content": text})

    if not turns:
        turns = [{"role": "user", "content": "Hello"}]
    if not sys_msg:
        sys_msg = {"role": "system", "content": "You are OMega, a concise and helpful local AI assistant."}
    max_turns = 6 if compact_for_cpu else 10
    recent = turns[-max_turns:]
    while recent and recent[0]["role"] != "user":
        recent.pop(0)
    if not recent:
        recent = [{"role": "user", "content": "Hello"}]
    return [sys_msg] + recent


def handle_chat(req: Dict[str, Any]) -> None:
    import torch
    from transformers import TextIteratorStreamer

    req_id = str(req.get("id", ""))
    model_dir = str(req.get("model_dir", ""))
    model_id = str(req.get("model_id", "local"))
    temperature = float(req.get("temperature") or 0.2)
    max_tokens = min(int(req.get("max_tokens") or 512), 2048)
    stream = bool(req.get("stream", False))

    load_model(model_dir, model_id, req_id)
    compact_for_cpu = bool(STATE.get("is_cpu", False))
    messages = normalize_messages(req.get("messages") or [], compact_for_cpu=compact_for_cpu)
    tokenizer = STATE["tokenizer"]
    model = STATE["model"]

    used_chat_template = False
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        used_chat_template = True
        try:
            prompt_text = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True, enable_thinking=False
            )
        except TypeError:
            prompt_text = tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
    else:
        prompt_text = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"

    target_device = getattr(model, "device", torch.device("cpu"))
    inputs = tokenizer(
        prompt_text,
        return_tensors="pt",
        add_special_tokens=not used_chat_template,
    ).to(target_device)

    prompt_tokens = int(inputs.input_ids.shape[-1])
    gen_kwargs: Dict[str, Any] = {
        **inputs,
        "max_new_tokens": max_tokens,
        "do_sample": temperature > 0,
        "use_cache": True,
    }
    if temperature > 0:
        gen_kwargs["temperature"] = temperature

    if stream:
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen_kwargs["streamer"] = streamer
        err_holder: List[str] = []

        def _run() -> None:
            try:
                with torch.inference_mode():
                    model.generate(**gen_kwargs)
            except Exception as exc:
                err_holder.append(str(exc))
                streamer.end()

        t = threading.Thread(target=_run, daemon=True)
        t.start()
        chunks: List[str] = []
        for piece in streamer:
            if piece:
                chunks.append(piece)
                emit({"id": req_id, "type": "delta", "text": piece})
        t.join()
        if err_holder:
            emit({"id": req_id, "type": "error", "error": err_holder[0]})
            return
        reply = "".join(chunks).strip()
        completion_tokens = max(1, len(reply) // 4)
        emit({
            "id": req_id,
            "type": "done",
            "content": reply,
            "model": model_id,
            "device": STATE["device_desc"],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        })
        return

    with torch.inference_mode():
        output_ids = model.generate(**gen_kwargs)
    generated_ids = output_ids[0][prompt_tokens:]
    reply = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()
    completion_tokens = int(len(generated_ids))
    emit({
        "id": req_id,
        "type": "done",
        "content": reply,
        "model": model_id,
        "device": STATE["device_desc"],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    })


def main() -> None:
    try:
        hw = detect_runtime_hardware()
        emit({"id": "init", "type": "ready", "hardware": hw})
    except Exception as exc:
        emit({"id": "init", "type": "error", "error": f"Missing Python ML dependencies ({exc}). Install torch & transformers."})
        return

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            cmd = req.get("cmd")
            if cmd == "ping":
                emit({"id": req_id, "type": "pong", "model": STATE["model_id"], "device": STATE["device_desc"]})
            elif cmd == "shutdown":
                emit({"id": req_id, "type": "bye"})
                break
            elif cmd == "warmup":
                model_dir = str(req.get("model_dir", ""))
                model_id = str(req.get("model_id", "local"))
                load_model(model_dir, model_id, req_id)
                emit({"id": req_id, "type": "done", "content": "warmed", "model": model_id, "device": STATE["device_desc"]})
            elif cmd == "chat":
                handle_chat(req)
            else:
                emit({"id": req_id, "type": "error", "error": f"Unknown command: {cmd}"})
        except Exception as exc:
            emit({"id": req_id, "type": "error", "error": str(exc)})


if __name__ == "__main__":
    main()
