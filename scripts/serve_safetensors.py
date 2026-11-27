#!/usr/bin/env python3
"""
Local Hugging Face Safetensors OpenAI-Compatible Server for OMega
-----------------------------------------------------------------
Serves local Hugging Face .safetensors directories (e.g. Gemma 3-4B, Gemma 4-E2B/E4B,
Qwen 3.8-27B, etc.) over an OpenAI-compatible REST endpoint
(http://127.0.0.1:8000/v1/chat/completions) with automatic multi-model discovery
and on-demand hot-swapping when `model` changes in requests.

Run server:
  python scripts/serve_safetensors.py
  python scripts/serve_safetensors.py --models-root "C:\\path\\to\\models" --model-id gemma-4-e2b
"""

import argparse
import gc
import json
import os
import re
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="OMega Safetensors Local Inference Server")

MODEL_LOCK = threading.Lock()

MODEL_STATE: Dict[str, Any] = {
    "model": None,
    "tokenizer": None,
    "model_id": os.environ.get("VLLM_MODEL", "gemma-3-4b"),
    "model_dir": "",
    "models_root": "",
    "registry": {},  # normalized_id -> abs_dir_path
    "default_max_tokens": 256,
    "history_turns": 6,
    "preserve_system": False,
    "load_in_4bit": False,
    "load_in_8bit": False,
    "offload_dir": "./offload_cache",
    "lora_dir": "",
}


def _load_dotenv(env_path: str = ".env") -> None:
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            if k and k not in os.environ:
                os.environ[k] = v


def _normalize_model_id(name: str) -> str:
    return re.sub(r"\s+", "-", name.strip().lower())


def _compact_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.strip().lower())


def _is_safetensors_dir(dir_path: str) -> bool:
    if not dir_path or not os.path.isdir(dir_path):
        return False
    try:
        entries = os.listdir(dir_path)
    except OSError:
        return False
    return any(f.endswith(".safetensors") for f in entries)


def _discover_local_models() -> Dict[str, str]:
    """Scan LOCAL_MODEL_PATH, models_root (LOCAL_MODELS_DIR), and om.config.json localModels."""
    registry: Dict[str, str] = {}

    def register(path: str, explicit_id: Optional[str] = None) -> None:
        if not path or not _is_safetensors_dir(path):
            return
        abs_path = os.path.abspath(path)
        mid = _normalize_model_id(explicit_id or os.path.basename(abs_path))
        if mid not in registry:
            registry[mid] = abs_path

    # 1. Explicit active model_dir
    if MODEL_STATE["model_dir"]:
        register(MODEL_STATE["model_dir"], MODEL_STATE["model_id"] or None)

    # 2. Explicit LOCAL_MODEL_PATH from env
    env_single = os.environ.get("LOCAL_MODEL_PATH", "")
    if env_single:
        register(env_single)

    # 3. Optional om.config.json providers.vllm.localModels map
    if os.path.exists("om.config.json"):
        try:
            with open("om.config.json", "r", encoding="utf-8") as f:
                cfg = json.load(f)
            local_map = cfg.get("providers", {}).get("vllm", {}).get("localModels", {})
            if isinstance(local_map, dict):
                for mid, p in local_map.items():
                    if isinstance(p, str):
                        register(p, mid)
        except Exception:
            pass

    # 4. Scan models_root directory for any subfolder containing .safetensors
    models_root = MODEL_STATE["models_root"]
    if models_root and os.path.isdir(models_root):
        try:
            for entry in sorted(os.scandir(models_root), key=lambda e: e.name.lower()):
                if entry.is_dir() and not entry.name.startswith("."):
                    register(entry.path)
        except OSError:
            pass

    MODEL_STATE["registry"] = registry
    return registry


def _resolve_model(requested: Optional[str]) -> Optional[tuple[str, str]]:
    """Resolve a requested model name (exact, normalized, or fuzzy) to (model_id, model_dir)."""
    registry = _discover_local_models()
    if not requested or requested in ("default", "local-model"):
        if MODEL_STATE["model_id"] and MODEL_STATE["model_dir"]:
            return MODEL_STATE["model_id"], MODEL_STATE["model_dir"]
        if registry:
            first_id = next(iter(registry))
            return first_id, registry[first_id]
        return None

    norm = _normalize_model_id(requested)
    if norm in registry:
        return norm, registry[norm]

    compact = _compact_key(requested)
    for mid, path in registry.items():
        if _compact_key(mid) == compact:
            return mid, path
    for mid, path in registry.items():
        if compact and compact in _compact_key(mid):
            return mid, path
    return None


def _load_model_into_memory(model_id: str, model_dir: str) -> None:
    """Unload any previously loaded model and load (model_id, model_dir) into MODEL_STATE."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if MODEL_STATE["model"] is not None:
        print(f"[OMega Safetensors] Unloading previous model '{MODEL_STATE['model_id']}'...", flush=True)
        MODEL_STATE["model"] = None
        MODEL_STATE["tokenizer"] = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    os.makedirs(MODEL_STATE["offload_dir"], exist_ok=True)
    print(f"[OMega Safetensors] Loading tokenizer for '{model_id}' from: {model_dir}", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, trust_remote_code=True)

    load_kwargs: Dict[str, Any] = {
        "dtype": "auto",
        "low_cpu_mem_usage": True,
        "trust_remote_code": True,
    }
    if torch.cuda.is_available():
        load_kwargs["device_map"] = "auto"
        load_kwargs["offload_folder"] = MODEL_STATE["offload_dir"]
    if MODEL_STATE["load_in_4bit"] or MODEL_STATE["load_in_8bit"]:
        from transformers import BitsAndBytesConfig
        load_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=MODEL_STATE["load_in_4bit"],
            load_in_8bit=MODEL_STATE["load_in_8bit"],
        )

    device_desc = (
        f"device_map='auto' (offload: {MODEL_STATE['offload_dir']})"
        if torch.cuda.is_available()
        else "CPU (in-memory, no disk offload)"
    )
    print(f"[OMega Safetensors] Loading '{model_id}' on {device_desc}...", flush=True)
    try:
        model = AutoModelForCausalLM.from_pretrained(model_dir, **load_kwargs)
    except ValueError:
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(model_dir, **load_kwargs)

    lora_dir = MODEL_STATE["lora_dir"]
    if lora_dir and os.path.exists(lora_dir):
        from peft import PeftModel
        print(f"[OMega Safetensors] Loading LoRA adapter from: {lora_dir}", flush=True)
        model = PeftModel.from_pretrained(model, lora_dir)

    model.eval()
    MODEL_STATE["tokenizer"] = tokenizer
    MODEL_STATE["model"] = model
    MODEL_STATE["model_id"] = model_id
    MODEL_STATE["model_dir"] = model_dir
    print(f"[OMega Safetensors] Loaded '{model_id}' from {model_dir}", flush=True)


def _ensure_model_loaded(requested: Optional[str]) -> str:
    """Ensure the requested local model is loaded, hot-swapping if needed."""
    resolved = _resolve_model(requested)
    if resolved is None:
        available = list(MODEL_STATE["registry"].keys())
        raise HTTPException(
            status_code=404,
            detail=f"Local model '{requested}' not found. Available local models: {available}",
        )
    target_id, target_dir = resolved
    if MODEL_STATE["model"] is None or os.path.abspath(MODEL_STATE["model_dir"]) != os.path.abspath(target_dir):
        with MODEL_LOCK:
            if MODEL_STATE["model"] is None or os.path.abspath(MODEL_STATE["model_dir"]) != os.path.abspath(target_dir):
                _load_model_into_memory(target_id, target_dir)
    return MODEL_STATE["model_id"]


def _extract_text(content: Any) -> str:
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
    return str(content)


def _strip_dynamic_context(text: str) -> str:
    """When preserve_system is False, strip OMega's large [Dynamic Context] block to keep CPU prefill fast."""
    if text.startswith("[Dynamic Context]\n"):
        idx = text.rfind("\n\n")
        if idx != -1 and idx + 2 < len(text):
            return text[idx + 2 :].strip()
    return text


def _normalize_alternating(msgs: List[dict], strip_dynamic: bool = False) -> List[dict]:
    """Ensure user/assistant turns strictly alternate and start with user (required by Gemma 3/4)."""
    merged: List[dict] = []
    for m in msgs:
        role = m["role"]
        text = m["content"].strip()
        if strip_dynamic and role == "user":
            text = _strip_dynamic_context(text)
        if not text:
            continue
        if not merged:
            if role != "user":
                continue
            merged.append({"role": "user", "content": text})
        elif merged[-1]["role"] == role:
            merged[-1]["content"] += "\n\n" + text
        else:
            merged.append({"role": role, "content": text})
    return merged


class ChatMessage(BaseModel):
    role: str
    content: Any


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.2
    max_tokens: Optional[int] = None
    stream: Optional[bool] = False


class LoadModelRequest(BaseModel):
    model: str


@app.get("/")
def root_status():
    registry = _discover_local_models()
    return {
        "status": "online",
        "service": "OMega Safetensors Local Inference Server",
        "model": MODEL_STATE["model_id"],
        "model_dir": MODEL_STATE["model_dir"],
        "available_models": list(registry.keys()),
        "models_root": MODEL_STATE["models_root"],
        "note": "This is the background API server for OMega. Use http://127.0.0.1:3000 for the OMega Web Dashboard.",
    }


@app.get("/v1/models")
def list_models():
    registry = _discover_local_models()
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": mid,
                "object": "model",
                "created": now,
                "owned_by": "local-safetensors",
                "loaded": mid == MODEL_STATE["model_id"] and MODEL_STATE["model"] is not None,
                "path": path,
            }
            for mid, path in registry.items()
        ],
    }


@app.post("/v1/models/load")
def load_model_endpoint(req: LoadModelRequest):
    active_id = _ensure_model_loaded(req.model)
    return {
        "status": "loaded",
        "model": active_id,
        "model_dir": MODEL_STATE["model_dir"],
    }


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    import torch
    from transformers import TextIteratorStreamer, TextStreamer

    active_id = _ensure_model_loaded(req.model)
    tokenizer = MODEL_STATE["tokenizer"]
    model = MODEL_STATE["model"]

    raw_messages = [{"role": m.role, "content": _extract_text(m.content)} for m in req.messages]
    turns = MODEL_STATE["history_turns"]
    user_msgs = _normalize_alternating(
        [m for m in raw_messages if m["role"] in ("user", "assistant")][-turns:],
        strip_dynamic=not MODEL_STATE["preserve_system"],
    )
    if not user_msgs:
        user_msgs = [{"role": "user", "content": "Hello"}]
    sys_msg = (
        next((m for m in raw_messages if m["role"] == "system"), None)
        if MODEL_STATE["preserve_system"]
        else None
    )
    if not sys_msg:
        sys_msg = {"role": "system", "content": "You are OM, a concise AI assistant. Answer directly and briefly."}
    messages = [sys_msg] + user_msgs

    used_chat_template = False
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        used_chat_template = True
        try:
            prompt_text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            prompt_text = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
    else:
        prompt_text = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"

    max_new_tokens = min(req.max_tokens or MODEL_STATE["default_max_tokens"], 2048)
    inputs = tokenizer(
        prompt_text,
        return_tensors="pt",
        add_special_tokens=not used_chat_template,
    ).to(model.device)
    req_id = f"chatcmpl-{uuid.uuid4().hex[:10]}"

    if req.stream:
        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen_kwargs = {
            **inputs,
            "max_new_tokens": max_new_tokens,
            "do_sample": (req.temperature or 0) > 0,
            **({"temperature": req.temperature} if (req.temperature or 0) > 0 else {}),
            "use_cache": True,
            "streamer": streamer,
        }

        def _generate():
            try:
                with torch.inference_mode():
                    model.generate(**gen_kwargs)
            except Exception as exc:
                import traceback
                traceback.print_exc()
                print(f"[OMega Safetensors] Generation error: {exc}", flush=True)
                streamer.end()

        threading.Thread(target=_generate, daemon=True).start()

        def event_stream():
            for text in streamer:
                if text:
                    chunk = {
                        "id": req_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": active_id,
                        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n"
            done_chunk = {
                "id": req_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": active_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(done_chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    print(f"\n[OMega Safetensors] Generating response with '{active_id}' (max_new_tokens={max_new_tokens})...")
    t0 = time.time()
    streamer = TextStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)

    with torch.inference_mode():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            use_cache=True,
            streamer=streamer,
        )

    generated_ids = output_ids[0][inputs.input_ids.shape[-1] :]
    reply = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()
    elapsed = round(time.time() - t0, 1)
    print(f"\n[OMega Safetensors] Completed {len(generated_ids)} tokens in {elapsed}s.")

    return {
        "id": req_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": active_id,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(inputs.input_ids.shape[-1]),
            "completion_tokens": int(len(generated_ids)),
            "total_tokens": int(inputs.input_ids.shape[-1] + len(generated_ids)),
        },
    }


def main():
    _load_dotenv()
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model-dir",
        default=os.environ.get("LOCAL_MODEL_PATH", ""),
        help="Path to the initial Hugging Face .safetensors model folder (or set LOCAL_MODEL_PATH)",
    )
    parser.add_argument(
        "--models-root",
        default=os.environ.get("LOCAL_MODELS_DIR", ""),
        help="Parent directory scanned for local model folders (or set LOCAL_MODELS_DIR)",
    )
    parser.add_argument("--model-id", default=os.environ.get("VLLM_MODEL", ""))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--history-turns", type=int, default=6)
    parser.add_argument("--preserve-system", action="store_true")
    parser.add_argument("--load-in-4bit", action="store_true")
    parser.add_argument("--load-in-8bit", action="store_true")
    parser.add_argument("--offload-dir", default="./offload_cache")
    parser.add_argument("--lora-dir", default="", help="Optional PEFT LoRA adapter directory to load")
    parser.add_argument("--lazy", action="store_true", help="Do not load initial model until first request")
    args = parser.parse_args()

    models_root = args.models_root or (os.path.dirname(os.path.abspath(args.model_dir)) if args.model_dir else "")
    MODEL_STATE["models_root"] = models_root
    MODEL_STATE["model_dir"] = args.model_dir
    MODEL_STATE["model_id"] = _normalize_model_id(args.model_id) if args.model_id else ""
    MODEL_STATE["default_max_tokens"] = args.max_tokens
    MODEL_STATE["history_turns"] = args.history_turns
    MODEL_STATE["preserve_system"] = args.preserve_system
    MODEL_STATE["load_in_4bit"] = args.load_in_4bit
    MODEL_STATE["load_in_8bit"] = args.load_in_8bit
    MODEL_STATE["offload_dir"] = args.offload_dir
    MODEL_STATE["lora_dir"] = args.lora_dir

    registry = _discover_local_models()
    if not registry:
        parser.error("No local .safetensors model directories found. Set --model-dir / LOCAL_MODEL_PATH or --models-root / LOCAL_MODELS_DIR.")

    print(f"[OMega Safetensors] Discovered local models: {list(registry.keys())}", flush=True)

    if not args.lazy:
        initial = _resolve_model(MODEL_STATE["model_id"] or None)
        if initial:
            _load_model_into_memory(initial[0], initial[1])

    print(
        f"[OMega Safetensors] Ready at http://{args.host}:{args.port}/v1 (active: {MODEL_STATE['model_id']}, available: {list(registry.keys())})",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
