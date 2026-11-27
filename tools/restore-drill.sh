#!/usr/bin/env bash
# Doctine · restore one decrypted backup into a throwaway database and prove it is usable.
# Used by .github/workflows/restore-drill.yml; also runnable locally against a fictional dump (tests/restore-drill.test.sh).
#
#   DUMP=<file.dump> PGBIN=<dir with psql/pg_restore> \
#   DRILL_HOST/DRILL_PORT/DRILL_USER/DRILL_PASSWORD   an empty local PostgreSQL the drill may create databases in
#   LIVE_HOST/LIVE_PORT/LIVE_USER/LIVE_DB/LIVE_PASSWORD/LIVE_SSLMODE   the live database, read-only counts only
#   SUMMARY=<file>   where the pass/fail lines go (GITHUB_STEP_SUMMARY in CI)
#
# The repository is public, so this prints ONLY pass/fail per check: never data, names, ids or row counts.
# What it proves:
#   1. the dump holds data for every table the app has (public and private schemas), plus accounts and file records;
#   2. that data restores, without a single error, into a database built from the repository's migrations;
#   3. row counts match the live database (allowing for writes since the backup);
#   4. every reference between restored tables still points at a restored row;
#   5. with row-level security on, a restored person sees all of their own records and none of anyone else's.
set -euo pipefail
: "${DUMP:?}" "${PGBIN:?}" "${SUMMARY:=/dev/stdout}"
RUNNER_TEMP_DIR="${RUNNER_TEMP_DIR:-$(mktemp -d)}"
say() { echo "$1" >> "$SUMMARY"; }
fail=0; bad() { say "- FAIL: $1"; fail=1; }; ok() { say "- ok: $1"; }

drill() { PGHOST="$DRILL_HOST" PGPORT="${DRILL_PORT:-5432}" PGUSER="$DRILL_USER" PGPASSWORD="${DRILL_PASSWORD:-}" PGSSLMODE=disable "$@"; }
live()  { PGHOST="$LIVE_HOST" PGPORT="${LIVE_PORT:-5432}" PGUSER="$LIVE_USER" PGDATABASE="${LIVE_DB:-postgres}" PGPASSWORD="${LIVE_PASSWORD:-}" \
          PGSSLMODE="${LIVE_SSLMODE:-require}" PGOPTIONS='-c default_transaction_read_only=on' "$PGBIN/psql" -X -tA -v ON_ERROR_STOP=1 -c "$1"; }
D() { PGOPTIONS='-c client_min_messages=warning' drill "$PGBIN/psql" -X -q -tA -v ON_ERROR_STOP=1 -d drill "$@"; }

# Tables that change every few minutes by design: they only need to be present and non-empty when live is.
VOLATILE=" private.rate_limits private.uptime_checks private.analytics_events private.error_hits private.error_groups private.ai_traces private.admin_audit_log private.security_log private.ai_provider_checks private.ai_chat_events "
SKIP=" private.rate_limits "   # short-lived counters, purged continuously; never worth restoring or comparing

# 0. A fresh database with the app's schema, built from the migrations (never from the dump).
drill "$PGBIN/psql" -X -q -d postgres -c "drop database if exists drill" -c "create database drill" >/dev/null
D -f tests/supabase-stubs.sql >/dev/null
for m in $(ls supabase/migrations/2*.sql | sort); do D -f "$m" >/dev/null; done
# Test hook (tests/restore-drill.test.sh only): extra SQL applied to the throwaway copy, e.g. a deliberately broken rule.
[ -n "${DRILL_TEST_SQL:-}" ] && D -f "$DRILL_TEST_SQL" >/dev/null
say "Schema built from $(ls supabase/migrations/2*.sql | wc -l | tr -d ' ') migrations."
tables=$(D -c "select n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
               where c.relkind in ('r','p') and n.nspname in ('public','private') order by 1")

# 1. The dump covers every table, and accounts and file records.
"$PGBIN/pg_restore" --list "$DUMP" > "$RUNNER_TEMP_DIR/list"
missing=0
for t in $tables; do
  case "$SKIP" in *" $t "*) continue;; esac
  grep -qE "TABLE DATA ${t%%.*} ${t#*.} " "$RUNNER_TEMP_DIR/list" || missing=$((missing+1))
done
[ "$missing" = 0 ] && ok "the backup holds data for every app table (public and private)" || bad "$missing app table(s) are not in the backup"
for t in "auth users" "auth identities" "storage objects" "storage buckets"; do
  grep -qE "TABLE DATA $t " "$RUNNER_TEMP_DIR/list" && ok "the backup holds ${t/ /.}" || bad "${t/ /.} is not in the backup"
done

# 2. Restore the app's data. Seeded rows from the migrations are cleared first, so the backup is the only source.
D -c "set session_replication_role = replica" -c "do \$\$ declare r record; begin for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and n.nspname in ('public','private') loop execute format('truncate %I.%I cascade', r.nspname, r.relname); end loop; end \$\$" >/dev/null
grep -E "^[0-9]+; [0-9]+ [0-9]+ (TABLE DATA|SEQUENCE SET) (public|private) " "$RUNNER_TEMP_DIR/list" > "$RUNNER_TEMP_DIR/data.list"
for t in $SKIP; do grep -vE "TABLE DATA ${t%%.*} ${t#*.} " "$RUNNER_TEMP_DIR/data.list" > "$RUNNER_TEMP_DIR/d2" || true; mv "$RUNNER_TEMP_DIR/d2" "$RUNNER_TEMP_DIR/data.list"; done
if drill "$PGBIN/pg_restore" -d drill --data-only -L "$RUNNER_TEMP_DIR/data.list" --no-owner --no-privileges --disable-triggers "$DUMP" 2> "$RUNNER_TEMP_DIR/err"; then
  ok "the app's data restored with no errors"
else [ -n "${DRILL_DEBUG:-}" ] && cat "$RUNNER_TEMP_DIR/err" >&2; bad "pg_restore reported $(grep -c 'error' "$RUNNER_TEMP_DIR/err" || true) error(s) (details withheld)"; fi
# Accounts and file records: count the rows inside the dump (they restore into a new project's own auth/storage schema).
dumpcount() { "$PGBIN/pg_restore" -a -n "$1" -t "$2" -f - "$DUMP" | awk '/^COPY /{on=1;next} /^\\\.$/{on=0} on{n++} END{print n+0}'; }

# 3. Row counts against live.
counts_bad=0; counts_n=0
for t in $tables; do
  case "$SKIP" in *" $t "*) continue;; esac
  l=$(live "select count(*) from $t" 2>/dev/null || echo x); g=$(D -c "select count(*) from $t" 2>/dev/null || echo y)
  counts_n=$((counts_n+1))
  if [ "$l" = x ] || [ "$g" = y ]; then counts_bad=$((counts_bad+1)); continue; fi
  if [ "$l" != 0 ] && [ "$g" = 0 ]; then counts_bad=$((counts_bad+1)); continue; fi
  case "$VOLATILE" in *" $t "*) continue;; esac
  d=$(( g > l ? g - l : l - g )); m=$(( l / 5 > 3 ? l / 5 : 3 )); [ "$d" -le "$m" ] || counts_bad=$((counts_bad+1))
done
[ "$counts_bad" = 0 ] && ok "row counts of all $counts_n compared tables agree with the live database" || bad "$counts_bad of $counts_n tables differ from the live database by more than expected"
for p in "auth users" "auth identities" "storage objects"; do
  l=$(live "select count(*) from ${p/ /.}" 2>/dev/null || echo x); g=$(dumpcount ${p})
  if [ "$l" = x ]; then bad "${p/ /.}: live count unavailable"; continue; fi
  d=$(( g > l ? g - l : l - g )); m=$(( l / 5 > 3 ? l / 5 : 3 ))
  [ "$d" -le "$m" ] && { [ "$l" = 0 ] || [ "$g" -gt 0 ]; } && ok "${p/ /.} rows in the backup agree with the live database" || bad "${p/ /.} rows in the backup differ from the live database"
done

# 4. Every reference between restored app tables resolves (references to auth.users are checked against the dump's ids).
orph=$(D -c "do \$\$ declare r record; n bigint; total bigint := 0; cond text; begin
  for r in select c.oid, c.conrelid::regclass as src, c.confrelid::regclass as dst, c.conkey, c.confkey
           from pg_constraint c join pg_class s on s.oid=c.conrelid join pg_namespace ns on ns.oid=s.relnamespace
           join pg_class d on d.oid=c.confrelid join pg_namespace nd on nd.oid=d.relnamespace
           where c.contype='f' and ns.nspname in ('public','private') and nd.nspname in ('public','private') loop
    select string_agg(format('s.%I is not null', a.attname), ' and ') into cond from unnest(r.conkey) k join pg_attribute a on a.attrelid=r.src and a.attnum=k;
    execute format('select count(*) from %s s where %s and not exists (select 1 from %s d where %s)', r.src, cond, r.dst,
      (select string_agg(format('d.%I = s.%I', fa.attname, sa.attname), ' and ') from unnest(r.conkey, r.confkey) as u(sk, fk)
         join pg_attribute sa on sa.attrelid=r.src and sa.attnum=u.sk join pg_attribute fa on fa.attrelid=r.dst and fa.attnum=u.fk)) into n;
    total := total + n; end loop;
  raise warning 'ORPHANS=%', total; end \$\$" 2>&1 | sed -n 's/.*ORPHANS=\([0-9]*\).*/\1/p')
[ "$orph" = 0 ] && ok "every reference between restored tables points at a restored row" || bad "some restored rows point at rows that are not in the backup"
D -c "create temp table dump_users(id uuid)" >/dev/null
uid_col=$("$PGBIN/pg_restore" -a -n auth -t users -f - "$DUMP" | awk '/^COPY auth.users /{print; exit}' | sed 's/.*(\(.*\)) FROM.*/\1/' | tr -d ' ' | tr ',' '\n' | grep -nx '"\?id"\?' | cut -d: -f1)
if [ -n "$uid_col" ]; then
  "$PGBIN/pg_restore" -a -n auth -t users -f - "$DUMP" | awk '/^COPY /{on=1;next} /^\\\.$/{on=0} on' | cut -f"$uid_col" \
    | { D -c "create table public._drill_users(id uuid primary key)" -c "copy public._drill_users from stdin"; } >/dev/null
  no_owner=$(D -c "select coalesce(sum(n),0) from (
     select count(*) n from public.documents x where not exists (select 1 from public._drill_users u where u.id=x.user_id) union all
     select count(*) from public.health_records x where not exists (select 1 from public._drill_users u where u.id=x.user_id) union all
     select count(*) from public.health_profiles x where not exists (select 1 from public._drill_users u where u.id=x.user_id)) q")
  [ "$no_owner" = 0 ] && ok "every restored medical record belongs to an account in the backup" || bad "some restored medical records belong to no account in the backup"
  D -c "drop table public._drill_users" >/dev/null
else bad "could not read account ids from the backup"; fi

# 5. Row-level security on the restored data: a person sees all of their own records and nothing of anyone else's.
nors=$(D -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','private') and not c.relrowsecurity")
[ "$nors" = 0 ] && ok "row-level security is on for every restored table" || bad "$nors restored table(s) lack row-level security"
med="documents document_files document_pages health_records health_profiles lab_results prescriptions medicines vital_readings conversations messages"
who=$(D -c "select user_id from public.documents group by 1 order by count(*) desc limit 1")
[ -n "$who" ] || who=$(D -c "select user_id from public.health_records group by 1 order by count(*) desc limit 1")
if [ -z "$who" ]; then say "- skipped: no medical records in the backup to test row-level security with"
else
  leak=0; short=0; others=0
  for t in $med; do
    D -c "select 1 from information_schema.columns where table_schema='public' and table_name='$t' and column_name='user_id'" | grep -q 1 || continue
    own=$(D -c "select count(*) from public.$t where user_id='$who'"); oth=$(D -c "select count(*) from public.$t where user_id<>'$who'")
    seen=$(D -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub','$who',true);
                 select count(*) filter (where user_id='$who') ||' '|| count(*) filter (where user_id<>'$who') from public.$t; commit;" | tail -1)
    [ "${seen#* }" = 0 ] || leak=$((leak+1)); [ "${seen% *}" = "$own" ] || short=$((short+1)); [ "$oth" = 0 ] || others=1
    seen=$(D -c "begin; set local role anon; select count(*) from public.$t; commit;" 2>/dev/null | tail -1 || echo 0)
    [ "${seen:-0}" = 0 ] || leak=$((leak+1))
  done
  [ "$leak" = 0 ] && ok "a restored person (and a signed-out visitor) sees none of anyone else's medical records" || bad "row-level security let records through on $leak check(s)"
  [ "$short" = 0 ] && ok "a restored person sees all of their own medical records" || bad "a restored person is missing their own records on $short table(s)"
  [ "$others" = 1 ] || say "- note: the backup holds one person's records only, so the cross-person check had nothing to hide"
fi

drill "$PGBIN/psql" -X -q -d postgres -c "drop database drill" >/dev/null
[ "$fail" = 0 ] && say "**Restore drill passed.**" || { say "**Restore drill FAILED.**"; exit 1; }
