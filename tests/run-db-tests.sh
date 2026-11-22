#!/usr/bin/env bash
# Doctine · run the database tests in a brand-new, throw-away PostgreSQL cluster.
# Needs PostgreSQL 15+ server binaries (initdb, pg_ctl). Never point this at a real Supabase project.
# Usage: tests/run-db-tests.sh            (run as a normal user; as root it uses a temporary "pgtest" user)
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL server binaries not found (set PGBIN)"; exit 1; }
WORK="$(mktemp -d)"; PORT="${PORT:-55432}"
cp tests/supabase-stubs.sql tests/rls.test.sql tests/conversations.test.sql tests/ratelimit.test.sql supabase/migrations/*.sql "$WORK/" 2>/dev/null || true
chmod 755 "$WORK"; chmod 644 "$WORK"/*.sql
RUN=""; if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown -R pgtest "$WORK"; RUN="su pgtest -c"; fi
q() { if [ -n "$RUN" ]; then $RUN "$1"; else bash -c "$1"; fi; }
q "$PGBIN/initdb -D $WORK/data -A trust -U postgres >/dev/null"
q "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/log start -w >/dev/null"
trap 'q "$PGBIN/pg_ctl -D $WORK/data stop -m fast >/dev/null" || true; rm -rf "$WORK"' EXIT
P="psql -h $WORK -p $PORT -U postgres -q -v ON_ERROR_STOP=1"
$P -c "create database doctine_test" >/dev/null
$P -d doctine_test -f "$WORK/supabase-stubs.sql" >/dev/null
for m in $(ls "$WORK"/2*.sql | sort); do $P -d doctine_test -f "$m" >/dev/null; echo "migration applied: $(basename "$m")"; done
fail=0; json_items=""
for t in rls.test.sql conversations.test.sql ratelimit.test.sql; do
  [ -f "$WORK/$t" ] || { echo "missing test file $t"; fail=1; continue; }
  if out="$($P -d doctine_test -f "$WORK/$t" 2>&1)"; then status=passed; else status=failed; fail=1; fi
  oks="$(echo "$out" | grep -o "ok: .*" || true)"
  echo "$oks" | sed '/^$/d; s/^/  /'
  if [ "$status" = passed ]; then echo "$out" | grep -E "PASSED" || true; else echo "$out" | grep -E "FAILED|ERROR" | head -5 || true; fi
  n=$(echo "$oks" | sed '/^$/d' | wc -l)
  err="$( { echo "$out" | grep -E "FAILED|ERROR" || true; } | head -1 | tr -d '"\\' )"
  json_items="$json_items{\"file\":\"$t\",\"status\":\"$status\",\"checks_passed\":$n,\"error\":\"$err\"},"
done
if [ -n "${REPORT_DIR:-}" ]; then
  mkdir -p "$REPORT_DIR"
  pgv="$($P -tA -c 'show server_version')"
  printf '{"suite":"database","kind":"real PostgreSQL %s with Supabase auth/storage stand-ins (tests/supabase-stubs.sql)","migrations":%s,"files":[%s]}\n' \
    "$pgv" "$(ls "$WORK"/2*.sql | xargs -n1 basename | sed 's/.*/"&"/' | paste -sd, | sed 's/^/[/;s/$/]/')" "${json_items%,}" > "$REPORT_DIR/database.json"
fi
exit $fail
