#!/usr/bin/env python3
"""
Local Hugging Face Safetensors OpenAI-Compatible Server for OMega
-----------------------------------------------------------------
Serves a local Hugging Face .safetensors directory (such as Qwen 3.8-27B)
over an OpenAI-compatible REST endpoint (http://127.0.0.1:8000/v1/chat/completions)
with automatic CPU/GPU/Disk offloading (`device_map="auto"`) for 16GB RAM systems.

Run server:
  python scripts/serve_safetensors.py --model-dir "C:\\Users\\E20141007\\Desktop\\Qwen 3.8-27b" --port 8000
"""

import argparse
import json
import os
import threading
import time
import uuid
from typing import List, Optional, Any

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="OMega Safetensors Local Inference Server")

MODEL_STATE = {
    "model": None,
    "tokenizer": None,
    "model_id": "qwen3.8-27b",
    "model_dir": r"C:\Users\E20141007\Desktop\Qwen 3.8-27b",
    "default_max_tokens": 256,
    "history_turns": 6,
    "preserve_system": False,
}


class ChatMessage(BaseModel):
    role: str
    content: Any


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = "qwen3.8-27b"
    messages: List[ChatMessage]
    temperature: Optional[float] = 0.2
    max_tokens: Optional[int] = None
    stream: Optional[bool] = False


@app.get("/")
def root_status():
    return {
        "status": "online",
        "service": "OMega Safetensors Local Inference Server",
        "model": MODEL_STATE["model_id"],
        "model_dir": MODEL_STATE["model_dir"],
        "note": "This is the background API server for OMega. Use http://127.0.0.1:3000 for the OMega Web Dashboard.",
    }


@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_STATE["model_id"],
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local-safetensors",
            }
        ],
    }


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    import torch
    from transformers import TextStreamer, TextIteratorStreamer

    tokenizer = MODEL_STATE["tokenizer"]
    model = MODEL_STATE["model"]

    raw_messages = [{"role": m.role, "content": str(m.content)} for m in req.messages]
    turns = MODEL_STATE["history_turns"]
    user_msgs = [m for m in raw_messages if m["role"] in ("user", "assistant")][-turns:]
    sys_msg = (
        next((m for m in raw_messages if m["role"] == "system"), None)
        if MODEL_STATE["preserve_system"]
        else None
    )
    if not sys_msg:
        sys_msg = {"role": "system", "content": "You are OM, a concise AI assistant. Answer directly and briefly."}
    messages = [sys_msg] + user_msgs

    if hasattr(tokenizer, "apply_chat_template"):
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
    inputs = tokenizer(prompt_text, return_tensors="pt").to(model.device)
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
            with torch.inference_mode():
                model.generate(**gen_kwargs)

        threading.Thread(target=_generate, daemon=True).start()

        def event_stream():
            for text in streamer:
                if text:
                    chunk = {
                        "id": req_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": MODEL_STATE["model_id"],
                        "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n"
            done_chunk = {
                "id": req_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": MODEL_STATE["model_id"],
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(done_chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    print(f"\n[OMega Safetensors] Generating response (max_new_tokens={max_new_tokens})...")
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
        "model": MODEL_STATE["model_id"],
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
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model-dir",
        default=os.environ.get("LOCAL_MODEL_PATH", r"C:\Users\E20141007\Desktop\Qwen 3.8-27b"),
        help="Path to the Hugging Face .safetensors model folder",
    )
    parser.add_argument("--model-id", default="qwen3.8-27b")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--history-turns", type=int, default=6)
    parser.add_argument("--preserve-system", action="store_true")
    parser.add_argument("--load-in-4bit", action="store_true")
    parser.add_argument("--load-in-8bit", action="store_true")
    parser.add_argument("--offload-dir", default="./offload_cache")
    parser.add_argument("--lora-dir", default="", help="Optional PEFT LoRA adapter directory to load")
    args = parser.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    os.makedirs(args.offload_dir, exist_ok=True)
    print(f"[OMega Safetensors] Loading tokenizer from: {args.model_dir}")
    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, trust_remote_code=True)

    load_kwargs = {
        "torch_dtype": "auto",
        "device_map": "auto",
        "offload_folder": args.offload_dir,
        "low_cpu_mem_usage": True,
        "trust_remote_code": True,
    }
    if args.load_in_4bit or args.load_in_8bit:
        from transformers import BitsAndBytesConfig
        load_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=args.load_in_4bit,
            load_in_8bit=args.load_in_8bit,
        )

    print(f"[OMega Safetensors] Loading model with device_map='auto' (offload: {args.offload_dir})...")
    model = AutoModelForCausalLM.from_pretrained(args.model_dir, **load_kwargs)
    if args.lora_dir and os.path.exists(args.lora_dir):
        from peft import PeftModel
        print(f"[OMega Safetensors] Loading LoRA adapter from: {args.lora_dir}")
        model = PeftModel.from_pretrained(model, args.lora_dir)
    model.eval()

    MODEL_STATE["tokenizer"] = tokenizer
    MODEL_STATE["model"] = model
    MODEL_STATE["model_id"] = args.model_id
    MODEL_STATE["model_dir"] = args.model_dir
    MODEL_STATE["default_max_tokens"] = args.max_tokens
    MODEL_STATE["history_turns"] = args.history_turns
    MODEL_STATE["preserve_system"] = args.preserve_system

    print(f"[OMega Safetensors] Ready at http://{args.host}:{args.port}/v1 (model: {args.model_id})")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
