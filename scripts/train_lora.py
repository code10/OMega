#!/usr/bin/env python3
"""
Nightly QLoRA / LoRA Fine-Tuning Script for OMega Local Models
--------------------------------------------------------------
Consumes `sft.jsonl` (and optional `dpo.jsonl`) exported by `OMTrainingPipeline`
(`om export-training`) and saves a lightweight LoRA adapter that can be loaded
directly by `scripts/serve_safetensors.py --lora-dir <output-dir>`.

Example:
  python scripts/train_lora.py --model-dir "C:\\path\\to\\Qwen" --sft-file memory/training/sft.jsonl --output-dir adapters/daily
"""

import argparse
import json
import os


def load_jsonl(path):
    rows = []
    if not path or not os.path.exists(path):
        return rows
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True, help="Base Hugging Face model path")
    parser.add_argument("--sft-file", default="memory/training/sft.jsonl")
    parser.add_argument("--dpo-file", default="memory/training/dpo.jsonl")
    parser.add_argument("--output-dir", default="adapters/daily")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--load-in-4bit", action="store_true")
    args = parser.parse_args()

    sft_rows = load_jsonl(args.sft_file)
    if not sft_rows:
        print(f"[OMega Train] No SFT records found in {args.sft_file}; nothing to train.")
        return

    import torch
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, BitsAndBytesConfig
    from peft import LoraConfig, get_peft_model
    from trl import SFTTrainer

    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    load_kwargs = {"device_map": "auto", "trust_remote_code": True}
    if args.load_in_4bit:
        load_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)

    model = AutoModelForCausalLM.from_pretrained(args.model_dir, **load_kwargs)
    lora_cfg = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora_cfg)

    texts = []
    for row in sft_rows:
        msgs = row.get("messages", [])
        if hasattr(tokenizer, "apply_chat_template"):
            texts.append(tokenizer.apply_chat_template(msgs, tokenize=False))
        else:
            texts.append("\n".join(f"{m['role']}: {m.get('content', '')}" for m in msgs))

    dataset = Dataset.from_dict({"text": texts})
    os.makedirs(args.output_dir, exist_ok=True)

    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        dataset_text_field="text",
        args=TrainingArguments(
            output_dir=args.output_dir,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            learning_rate=args.lr,
            logging_steps=5,
            save_strategy="epoch",
            report_to="none",
        ),
    )
    trainer.train()
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"[OMega Train] Saved daily LoRA adapter to {args.output_dir} ({len(sft_rows)} SFT examples)")


if __name__ == "__main__":
    main()
