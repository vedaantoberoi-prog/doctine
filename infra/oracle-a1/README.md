# Doctine on Oracle Ampere A1: setup guide

**Status: prepared, not running.** Claude cannot reach Oracle Cloud, so no VM exists yet. Everything below is
configuration and instructions for the owner to run. Nothing in this guide touches production or patient data.

## What the server is for (and what it is not)

Doctine's patient data, sign-in, row-level security, patient context and medical-source search already live in
Supabase (Postgres), and the app and API run on Cloudflare. Moving any of that to a 2-core free VM would add risk and
cost nothing back. So the A1 starts with jobs that need no patient data and no inbound network access:

| Service | What it does | Data it touches | Network |
|---|---|---|---|
| `evaluator` | Runs the medical evaluation (`tests/live-eval.mjs`, 77 synthetic cases) against **staging**, on demand or weekly | Synthetic test messages only | Outbound HTTPS to staging |
| `llm-bench` (optional) | Builds llama.cpp for ARM64 and benchmarks a small local model | None | None at all (`network_mode: none`) |

Not on the A1 yet, on purpose:
- **Patient context and medical-source search**: already run inside Postgres, next to the data, under row-level
  security. Copying records to another machine would widen exposure for no gain.
- **Embeddings / vector search**: no approved medical sources are loaded yet, and Postgres full-text search covers the
  current need. If embeddings become worthwhile, Supabase's `pgvector` avoids a second database; the A1 could then
  generate embeddings for **public guidance only**, as a queued job.
- **Document processing**: today's scanning runs through the existing server with the AI provider. Moving it would
  mean sending patients' documents to this VM; that needs its own design, consent review and legal advice first.
- **A local model in the product**: only benchmarks. No local model answers people, and none would be used for
  diagnosis, prescribing or emergencies.

```
             people ──HTTPS──► Cloudflare (app + /api) ──► Supabase (data, RLS, search)
                                      │                 └► Anthropic (AI answers)
                                      ▲
 Oracle A1 (SSH only inbound) ──HTTPS─┘  evaluator: synthetic cases to STAGING with the evaluation token
                                         llm-bench: offline, no network
```

## Resource budget (2 OCPU, 12 GB RAM; estimates to be replaced by measurements)

| Item | Memory | CPU | Disk |
|---|---|---|---|
| Ubuntu + Docker + fail2ban | ~0.8–1 GB | idle | ~6 GB |
| `evaluator` (limit) | 512 MB | 0.5 core | < 50 MB image + reports |
| `llm-bench` (limit, only while benchmarking) | 7 GB | 1.5 cores | model file (1–5 GB) + ~1 GB build |
| Headroom for spikes and builds | ≥ 3 GB | — | keep the disk under 80% |

The two services never need to run at the same time. `verify.sh` prints real memory and disk figures; record them
in the table above after the first run.

## ARM64 compatibility

| Component | ARM64 | Notes |
|---|---|---|
| Ubuntu 24.04 (Canonical image for A1) | Yes | choose the aarch64 image |
| Docker Engine + Compose plugin | Yes | from Docker's apt repository (`arch=arm64`) |
| `node:22-bookworm-slim` | Yes | official multi-architecture image; pin the digest (see `evaluator.Dockerfile`) |
| Evaluation runner | Yes | plain Node, no native modules |
| llama.cpp | Yes | built from source on the VM with NEON; no emulation |
| Doctine app (Cloudflare Workers) | n/a | stays on Cloudflare |

None of these were built or run on ARM64 by Claude; the build steps below check it on the VM.

## Setup, step by step

### 1. Oracle Console (you)
1. **Networking → Virtual cloud networks → Start VCN wizard → "Create VCN with Internet Connectivity"**.
2. In the VCN's **public subnet → security list**, keep a single ingress rule: TCP 22 from **your own IP**
   (`<your-ip>/32`), not `0.0.0.0/0`. Remove any other ingress rule. Egress: all (needed for HTTPS out).
3. **Compute → Instances → Create instance**: Image *Canonical Ubuntu 24.04* (aarch64); Shape *VM.Standard.A1.Flex*,
   2 OCPU, 12 GB; the public subnet above; **paste your SSH public key** (the `.pub` file, never the private key);
   **Advanced options → Initialization script**: paste `infra/oracle-a1/cloud-init.yaml`.
4. Boot volume: the default 47 GB is enough.

Expected: the instance reaches *Running* in a few minutes; cloud-init then needs 5–10 more minutes.

### 2. First login and checks (you, on your computer)
```sh
ssh ubuntu@<public-ip>
cloud-init status --wait          # expect: status: done
docker version --format '{{.Server.Arch}}'   # expect: arm64
```

### 3. Get the code (read-only deploy key; the private key never leaves the VM)
```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/doctine_deploy -C "oracle-a1 read-only"
cat ~/.ssh/doctine_deploy.pub     # add in GitHub → repo → Settings → Deploy keys, "Allow write access" OFF
printf 'Host github.com\n  IdentityFile ~/.ssh/doctine_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
sudo install -d -o ubuntu /opt/doctine && git clone git@github.com:vedaantoberoi-prog/doctine.git /opt/doctine
```

### 4. The evaluation token (typed on the VM only)
Use the same value as the `EVAL_ACCESS_TOKEN` secret in Cloudflare staging and GitHub. Never paste it into a chat.
```sh
sudo nano /etc/doctine/evaluator.env     # one line:  EVAL_ACCESS_TOKEN=<the value>
sudo chmod 600 /etc/doctine/evaluator.env
```

### 5. Build and verify
```sh
cd /opt/doctine/infra/oracle-a1
sudo docker compose build evaluator
sudo sh verify.sh                        # expect: "All checks passed."
```

### 6. Run one evaluation (spends a little AI credit; ask the owner first)
```sh
sudo cp doctine-eval.service doctine-eval.timer /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl start doctine-eval && journalctl -u doctine-eval -n 30 --no-pager
ls /var/lib/doctine/reports              # expect: medical-eval.json and medical-eval.md
```
The runner refuses to start if the site doesn't report itself as staging, or if it is the production address.
The weekly timer stays **off** unless the owner approves the recurring cost (`sudo systemctl enable --now doctine-eval.timer`).

### 7. Optional: local-model benchmark (no network, no patient data)
1. Choose a llama.cpp release tag and read its notes. Choose a small model in GGUF format and **check its licence
   allows commercial use**; record the licence, size and quantisation.
2. Copy the model file to `/var/lib/doctine/models/` (for example with `scp` from your computer).
3. ```sh
   LLAMA_CPP_REF=<tag> sudo -E docker compose --profile bench build llm-bench
   sudo docker compose --profile bench run --rm llm-bench /opt/llama/llama-bench -m /models/<file>.gguf -t 2 -o md | tee /var/lib/doctine/bench/$(date +%F).md
   ```
   `llama-bench` reports prompt-processing and generation speed (tokens/second). Also record load time and peak memory
   (`docker stats` in a second terminal). Quality has to be judged separately, on low-risk tasks with synthetic data.

## Security controls in this setup
- Inbound: SSH only, from one IP, keys only, no root login, fail2ban; nothing else listens (checked by `verify.sh`).
- No Docker remote API; containers run as uid 10001, read-only root filesystem, all capabilities dropped,
  `no-new-privileges`, memory/CPU/process limits, log rotation; the benchmark has no network.
- Secrets: only the staging evaluation token, in a root-owned mode-600 file outside git and outside the image.
  No Supabase keys, no AI provider key, no production credentials on this machine.
- Automatic security updates; hourly disk check logs a warning above 80%.

**Rotating the evaluation token**: generate a new value; update it in Cloudflare (staging `EVAL_ACCESS_TOKEN`),
GitHub (environment `staging`) and `/etc/doctine/evaluator.env`; redeploy staging; run `verify.sh`.

## Backups, updates, rollback
- Nothing on the VM is the only copy of anything: code is in GitHub, evaluation reports can be re-run, and the
  workflow `Medical evaluation (staging)` already keeps reports on `eval-report/*` branches. Copy any report you want
  to keep with `scp`.
- Update: `cd /opt/doctine && git pull && cd infra/oracle-a1 && sudo docker compose build evaluator && sudo sh verify.sh`.
- Roll back: `git checkout <previous-commit>` and rebuild. Remove everything: terminate the instance in the Oracle
  Console and delete the deploy key in GitHub.

## Data flow and privacy
The A1 sends synthetic evaluation messages to staging and receives the assistant's answers to them. It never
receives, stores or processes a real person's data. Before any patient data could be processed here (document
workers, embeddings of records), Doctine needs: a written data-flow and purpose, consent wording, encryption at rest
for the volume, an access-review process, and advice from a qualified lawyer on India's DPDP Act and rules
(including where data may be processed and stored). Those are open questions, not settled.
