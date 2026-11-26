#!/usr/bin/env python3
"""
Doctine Model Lab · LoRA fine-tuning for doctine-labx (lab-report extraction). Runs on a rented GPU, never in CI or in
the app. Every run is reproducible from: the config below, the SFT manifest's SHA-256 and the seed.

  pip install "torch" "transformers>=4.51" "peft>=0.15" "trl>=0.17" "datasets" "accelerate"   (on the GPU machine)
  python3 ai-lab/train/train_lora.py --data ai-lab/train/data/sft-v1 --out runs/labx-v0
  python3 ai-lab/train/train_lora.py --dry-run          (anywhere: checks the data and the config, estimates the work)

After training, evaluate the adapter on the frozen benchmark (eval/run_baseline.py gains a "--model labx" adapter
runner on the GPU box) and record a model card in registry/models.json. Nothing here deploys anything.
"""
import argparse, json, os, sys

CONFIG = {
    "base_model": "Qwen/Qwen3-1.7B",            # Apache-2.0 (checked 26 Nov 2026); re-check on the day of the run
    "comparison_base": "Qwen/Qwen3-4B",          # Apache-2.0; with --qlora
    "lora": {"r": 16, "alpha": 32, "dropout": 0.05, "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]},
    "train": {"epochs": 3, "lr": 2e-4, "scheduler": "cosine", "warmup_ratio": 0.03, "batch_tokens": 16384, "max_len": 2048, "seed": 20261126, "bf16": True},
    "chat_template_thinking": False,             # Qwen3: train and serve with thinking off (JSON only)
}


def read(path):
    return [json.loads(l) for l in open(path)]


def check(data_dir):
    meta = json.load(open(os.path.join(data_dir, "MANIFEST.json")))
    import hashlib
    for p in ("train", "dev"):
        got = hashlib.sha256(open(os.path.join(data_dir, f"{p}.jsonl"), "rb").read()).hexdigest()
        if got != meta["sha256"][p]: sys.exit(f"{p}.jsonl does not match its manifest")
    rows = read(os.path.join(data_dir, "train.jsonl"))
    for e in rows:
        roles = [m["role"] for m in e["messages"]]
        if roles != ["system", "user", "assistant"]: sys.exit(f"{e['id']}: messages must be system, user, assistant")
        json.loads(e["messages"][2]["content"])
    tokens = meta["approx_tokens"] * meta["train"] / max(meta["examples"], 1)
    return meta, int(tokens * CONFIG["train"]["epochs"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(os.path.dirname(__file__), "data", "sft-v1"))
    ap.add_argument("--out", default="runs/labx-v0")
    ap.add_argument("--qlora", action="store_true", help="4-bit base (for the 4B comparison)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    meta, train_tokens = check(a.data)
    plan = {"config": CONFIG, "data": {k: meta[k] for k in ("examples", "train", "dev", "sha256")}, "training_tokens_estimate": train_tokens,
            "gpu_hours_estimate_1.7B_lora_24GB": [round(train_tokens / 4000 / 3600, 2), round(train_tokens / 2000 / 3600, 2)],
            "note": "estimate from assumed throughput (2,000-4,000 tokens/s), not measured"}
    if a.dry_run:
        print(json.dumps(plan, indent=1)); return
    try:
        import torch  # noqa: F401
        from datasets import load_dataset
        from peft import LoraConfig
        from trl import SFTConfig, SFTTrainer
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except ImportError as e:
        sys.exit(f"training libraries are not installed here ({e.name}); run on the GPU machine, or use --dry-run")
    base = CONFIG["comparison_base"] if a.qlora else CONFIG["base_model"]
    tok = AutoTokenizer.from_pretrained(base)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16) if a.qlora else None
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.bfloat16, quantization_config=quant)
    ds = load_dataset("json", data_files={"train": os.path.join(a.data, "train.jsonl"), "dev": os.path.join(a.data, "dev.jsonl")})
    t = CONFIG["train"]; l = CONFIG["lora"]
    cfg = SFTConfig(output_dir=a.out, num_train_epochs=t["epochs"], learning_rate=t["lr"], lr_scheduler_type=t["scheduler"], warmup_ratio=t["warmup_ratio"],
                    per_device_train_batch_size=4, gradient_accumulation_steps=4, max_length=t["max_len"], bf16=t["bf16"], seed=t["seed"],
                    eval_strategy="epoch", save_strategy="epoch", logging_steps=20, assistant_only_loss=True, report_to=[])
    trainer = SFTTrainer(model=model, processing_class=tok, args=cfg, train_dataset=ds["train"], eval_dataset=ds["dev"],
                         peft_config=LoraConfig(r=l["r"], lora_alpha=l["alpha"], lora_dropout=l["dropout"], target_modules=l["target_modules"], task_type="CAUSAL_LM"))
    trainer.train()
    trainer.save_model(a.out)
    json.dump(plan, open(os.path.join(a.out, "doctine_run.json"), "w"), indent=1)
    print(f"adapter saved to {a.out}; evaluate it on extraction-v1 before anything else")


if __name__ == "__main__":
    main()
