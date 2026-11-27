#!/bin/sh
# Doctine · checks on the Oracle A1 VM. Run with: sudo sh infra/oracle-a1/verify.sh
# Prints facts only; never prints the contents of /etc/doctine/*.env.
set -u
ok() { printf '  ok   %s\n' "$1"; }
no() { printf '  NO   %s\n' "$1"; FAIL=1; }
FAIL=0
echo "Doctine Oracle A1 checks"
[ "$(uname -m)" = "aarch64" ] && ok "ARM64 (aarch64)" || no "not aarch64: $(uname -m)"
# Only SSH should listen on a public address
pub=$(ss -H -ltn | awk '{print $4}' | grep -v -E '^(127\.|\[::1\]|::1)' | grep -v -E ':22$' || true)
[ -z "$pub" ] && ok "only SSH listens on a public address" || no "other listening ports: $pub"
sshd -T 2>/dev/null | grep -q '^passwordauthentication no' && ok "SSH: passwords off" || no "SSH passwords are not off"
sshd -T 2>/dev/null | grep -q '^permitrootlogin no' && ok "SSH: root login off" || no "SSH root login is not off"
[ ! -S /var/run/docker.sock ] || [ "$(stat -c %a /var/run/docker.sock)" = "660" ] && ok "Docker socket not world-accessible" || no "Docker socket permissions"
ss -H -ltn | grep -q ':2375\|:2376' && no "Docker remote API is listening" || ok "no Docker remote API"
[ "$(stat -c %a /etc/doctine/evaluator.env 2>/dev/null)" = "600" ] && ok "evaluator.env is mode 600" || no "evaluator.env missing or not mode 600"
grep -q '^EVAL_ACCESS_TOKEN=.\+' /etc/doctine/evaluator.env 2>/dev/null && ok "evaluation token is set (value not shown)" || no "EVAL_ACCESS_TOKEN not set in /etc/doctine/evaluator.env"
grep -q -v -E '^(EVAL_ACCESS_TOKEN=|#|$)' /etc/doctine/evaluator.env 2>/dev/null && no "evaluator.env holds more than the evaluation token" || ok "evaluator.env holds only the evaluation token"
docker image inspect doctine-evaluator:local >/dev/null 2>&1 && [ "$(docker image inspect -f '{{.Architecture}}' doctine-evaluator:local)" = "arm64" ] && ok "evaluator image built for arm64" || no "evaluator image not built (docker compose build evaluator)"
docker image inspect doctine-evaluator:local >/dev/null 2>&1 && ! docker image inspect -f '{{json .Config.Env}}' doctine-evaluator:local | grep -q TOKEN && ok "no token inside the image" || true
systemctl is-active --quiet unattended-upgrades && ok "automatic security updates on" || no "unattended-upgrades not active"
systemctl is-active --quiet fail2ban && ok "fail2ban on" || no "fail2ban not active"
use=$(df --output=pcent / | tail -1 | tr -dc 0-9); [ "$use" -lt 80 ] && ok "root disk ${use}% used" || no "root disk ${use}% used"
echo "Memory:"; free -m | sed 's/^/  /'
echo "Running containers (should be none between runs):"; docker ps --format '  {{.Names}} {{.Status}}' 2>/dev/null
[ "$FAIL" = 0 ] && echo "All checks passed." || { echo "Some checks failed."; exit 1; }
