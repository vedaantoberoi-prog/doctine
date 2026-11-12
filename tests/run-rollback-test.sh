#!/usr/bin/env bash
# Doctine · rollback check in a throw-away PostgreSQL cluster: all migrations, a fictional Founder and Co-Founders, then
# supabase/rollback/20261112040000_leadership_down.sql and a re-run of the v2 migration; the v2 roles and functions must work.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"; W="$(mktemp -d)"; P=55433
cp tests/supabase-stubs.sql supabase/migrations/*.sql supabase/rollback/*.sql "$W/"; chmod 755 "$W"; chmod 644 "$W"/*.sql
id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown -R pgtest "$W"
q() { su pgtest -c "$1"; }
q "$PGBIN/initdb -D $W/data -A trust -U postgres >/dev/null"
q "$PGBIN/pg_ctl -D $W/data -o '-k $W -p $P -c listen_addresses=' -l $W/log start -w >/dev/null"
trap 'q "$PGBIN/pg_ctl -D $W/data stop -m fast >/dev/null" || true; rm -rf "$W"' EXIT
S="psql -h $W -p $P -U postgres -q -v ON_ERROR_STOP=1 -d postgres"
$S -f "$W/supabase-stubs.sql" >/dev/null
for m in $(ls "$W"/2*.sql | grep -v _down | sort); do $S -f "$m" >/dev/null; done
$S -c "insert into auth.users (id, email, email_confirmed_at) values ('a0000000-0000-0000-0000-000000000001','f@example.test',now()),('a0000000-0000-0000-0000-000000000002','c@example.test',now()),('a0000000-0000-0000-0000-000000000003','s@example.test',now());
insert into private.admin_members (user_id, role, permissions) values ('a0000000-0000-0000-0000-000000000001','founder','{}'),('a0000000-0000-0000-0000-000000000002','co_founder',private.perm_preset('admin')),('a0000000-0000-0000-0000-000000000003','co_founder',private.perm_preset('support'));"
$S -f "$W/20261112040000_leadership_down.sql" >/dev/null
$S -f "$W/20261112030000_admin_console_v2.sql" >/dev/null
$S -At -c "select string_agg(u.email || '=' || m.role, ',' order by u.email) from private.admin_members m join auth.users u on u.id = m.user_id"
$S -At -c "select public.admin_me('a0000000-0000-0000-0000-000000000001')->>'role', (public.admin_me('a0000000-0000-0000-0000-000000000002')->'perms') ? 'flags.manage', (select count(*) from pg_proc where proname = 'admin_team_set')"
echo ROLLBACK OK
