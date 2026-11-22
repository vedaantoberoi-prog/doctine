#!/usr/bin/env bash
# Doctine · build the FICTIONAL evaluation corpus in a throw-away PostgreSQL with every migration applied, so the
# evidence index is made by the real database code, then dump each person's rows (as that person, row security on)
# to JSON for tools/rag-eval.mjs.  Usage: tools/rag-eval-db.sh <out-dir>
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?output directory}"; mkdir -p "$OUT"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"; PORT="${PORT:-55433}"
cp tests/supabase-stubs.sql supabase/migrations/*.sql "$WORK/"
node -e 'import("./tests/fixtures/rag-corpus.mjs").then(m => process.stdout.write(m.corpusSql()))' > "$WORK/corpus.sql"
chmod 755 "$WORK"; chmod 644 "$WORK"/*.sql
RUN=""; if [ "$(id -u)" = "0" ]; then id pgtest >/dev/null 2>&1 || useradd -m pgtest; chown -R pgtest "$WORK"; RUN="su pgtest -c"; fi
q() { if [ -n "$RUN" ]; then $RUN "$1"; else bash -c "$1"; fi; }
q "$PGBIN/initdb -D $WORK/data -A trust -U postgres >/dev/null"
q "$PGBIN/pg_ctl -D $WORK/data -o '-k $WORK -p $PORT -c listen_addresses=' -l $WORK/log start -w >/dev/null"
trap 'q "$PGBIN/pg_ctl -D $WORK/data stop -m fast >/dev/null" || true; rm -rf "$WORK"' EXIT
P="psql -h $WORK -p $PORT -U postgres -q -v ON_ERROR_STOP=1 -d rag"
psql -h $WORK -p $PORT -U postgres -q -c "create database rag" >/dev/null
$P -f "$WORK/supabase-stubs.sql" >/dev/null
for m in $(ls "$WORK"/2*.sql | sort); do $P -f "$m" >/dev/null 2>&1; done
$P -f "$WORK/corpus.sql" >/dev/null
for who in a1:e0a00000-0000-4000-8000-0000000000a1 b2:e0b00000-0000-4000-8000-0000000000b2; do
  name="${who%%:*}"; uid="${who#*:}"
  $P -tA -c "select set_config('request.jwt.claim.sub', '$uid', false); set role authenticated;
    select jsonb_build_object(
      'documents', (select coalesce(jsonb_agg(d order by d.client_id), '[]') from (select id, client_id, title, category, document_date, provider, fields, page_count from documents) d),
      'lab_results', (select coalesce(jsonb_agg(l), '[]') from (select id, document_id, test, value, unit, reference_range, flag, confidence, origin from lab_results) l),
      'document_chunks', (select coalesce(jsonb_agg(c order by c.document_id, c.position), '[]') from (select id, document_id, page, kind, section, parent_key, position, content, context, verification from document_chunks) c),
      'status', (select jsonb_agg(s) from document_index_status s))" | tail -1 > "$OUT/person-$name.json"
done
echo "corpus indexed by the real migrations: $(node -e "const j=require(require('path').resolve('$OUT/person-a1.json'));console.log(j.documents.length+' documents, '+j.document_chunks.length+' pieces (person A)')")"
