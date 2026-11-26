#!/usr/bin/env bash
# Doctine · tests for tools/restore-drill.sh, entirely local and fictional.
# Builds a stand-in "live" database from the migrations, fills it with two fictional people, dumps it the way
# backup.yml does, and runs the drill against it. Then checks that the drill FAILS when the dump leaves out the
# private schema (the gap the nightly backup had before) and when a person's records are missing from the dump.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"; PORT="${PORT:-55433}"
RUN=""; if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown -R pgtest "$WORK"; RUN="su pgtest -c"; fi
q() { if [ -n "$RUN" ]; then $RUN "$1"; else bash -c "$1"; fi; }
q "$PGBIN/initdb -D $WORK/data -A trust -U postgres >/dev/null"
q "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/log start -w >/dev/null"
trap 'q "$PGBIN/pg_ctl -D $WORK/data stop -m fast >/dev/null" || true; rm -rf "$WORK"' EXIT
export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres PGOPTIONS='-c client_min_messages=warning'
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1"
$P -d postgres -c "create database live" >/dev/null
$P -d live -f tests/supabase-stubs.sql >/dev/null
for m in $(ls supabase/migrations/2*.sql | sort); do $P -d live -f "$m" >/dev/null; done
$P -d live >/dev/null <<'SQL'
insert into auth.users (id, email) values ('a1000000-0000-4000-8000-000000000001','asha@example.test'), ('a1000000-0000-4000-8000-000000000002','ravi@example.test');
insert into auth.identities (user_id, provider) select id, 'email' from auth.users;
insert into storage.buckets (id, name, public) values ('drill-docs','drill-docs',false) on conflict do nothing;
insert into storage.objects (bucket_id, name) values ('drill-docs','a1000000-0000-4000-8000-000000000001/x.pdf');
insert into public.documents (user_id, client_id, title) select 'a1000000-0000-4000-8000-000000000001', g, 'Fictional report '||g from generate_series(1,5) g;
insert into public.documents (user_id, client_id, title) values ('a1000000-0000-4000-8000-000000000002', 1, 'Fictional scan');
insert into public.health_records (user_id, client_id, kind, title) values ('a1000000-0000-4000-8000-000000000001', 1, 'condition', 'Fictional condition'),
  ('a1000000-0000-4000-8000-000000000002', 1, 'condition', 'Fictional condition two');
SQL
dump() { $PGBIN/pg_dump -d live -Fc --no-owner --no-privileges "$@" -f "$WORK/db.dump"; }
drill() { DRILL_TEST_SQL="${DRILL_TEST_SQL:-}" DUMP="$WORK/db.dump" PGBIN="$PGBIN" SUMMARY="$WORK/summary" DRILL_HOST="$WORK" DRILL_PORT="$PORT" DRILL_USER=postgres \
          LIVE_HOST="$WORK" LIVE_PORT="$PORT" LIVE_USER=postgres LIVE_DB=live LIVE_SSLMODE=disable DRILL_DEBUG=1 bash tools/restore-drill.sh >/dev/null 2>"$WORK/stderr"; }
fail=0
check() { if [ "$1" = "$2" ]; then echo "ok: $3"; [ -n "${SHOW:-}" ] && { grep FAIL "$WORK/summary" | sed "s/^/    /" || true; }; true; else echo "FAILED: $3"; sed 's/^/    /' "$WORK/summary"; head -20 "$WORK/stderr" | sed 's/^/    /'; fail=1; fi; }

: > "$WORK/summary"; dump --schema=public --schema=private --schema=auth --schema=storage
if drill; then r=pass; else r=fail; fi; check "$r" pass "a complete backup passes the drill"
grep -q "sees none of anyone else" "$WORK/summary" && echo "ok: the drill ran the cross-person row-level security check" || { echo "FAILED: cross-person check missing"; fail=1; }
grep -q "belongs to an account" "$WORK/summary" && echo "ok: the drill checked every record has an account" || { echo "FAILED: owner check missing"; fail=1; }

: > "$WORK/summary"; dump --schema=public --schema=auth --schema=storage
if drill; then r=pass; else r=fail; fi; check "$r" fail "a backup without the private schema fails the drill"

: > "$WORK/summary"; dump --schema=public --schema=private --schema=auth --schema=storage --exclude-table-data=public.documents
if drill; then r=pass; else r=fail; fi; check "$r" fail "a backup missing the documents' rows fails the drill"

# a broken access rule must be caught: give every signed-in person read access to all documents in the drill copy
echo 'create policy "drill test: leak" on public.documents for select to authenticated using (true);' > "$WORK/leak.sql"
: > "$WORK/summary"; dump --schema=public --schema=private --schema=auth --schema=storage
if DRILL_TEST_SQL="$WORK/leak.sql" drill; then r=pass; else r=fail; fi; check "$r" fail "a restored copy whose access rules leak fails the drill"
grep -q "row-level security let records through" "$WORK/summary" && echo "ok: the leak was reported as a row-level security failure" || { echo "FAILED: leak not reported"; fail=1; }

[ "$fail" = 0 ] && echo "Restore drill tests PASSED" || { echo "Restore drill tests FAILED"; exit 1; }
