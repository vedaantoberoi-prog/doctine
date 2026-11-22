-- Doctine · medical evidence index (23 Nov 2026). Additive only; nothing existing is changed or deleted.
--
--   document_pages   the text of each page as read when the document was added (PDF text layer, or the AI transcription
--                    of a photo). Written by the app for the person's own documents. Kept so answers can cite a page.
--   document_chunks  searchable pieces of each document, BUILT ONLY BY THE DATABASE from the person's own records:
--                      lab_row         one lab result with its name, value, unit, range and flag kept together
--                      medication_line one prescription line as written plus its reading
--                      section         diagnoses, complaints, advice, tests advised
--                      field           other confirmed details of non-lab documents
--                      page_text / transcription   page text in pieces of about 700 characters, split on line breaks
--                    Each piece keeps its original text (`content`) and, separately, a context line made ONLY from the
--                    document's own details (type, title, provider, date, page, section): nothing is invented.
--                    Rebuilt automatically whenever the document, its AI reading or its pages change, and removed with
--                    the document (foreign keys), so the index can't serve deleted or outdated text.
--   search_document_chunks(terms, limit)   full-text candidates for the signed-in person (row security applies).
--   document_index_status   per document: is it searchable, how many pieces, page text present.
-- Same owner-only rules as the other health tables. People can't write chunks directly.
-- Rollback: supabase/rollback/20261123010000_evidence_index_down.sql

create table if not exists public.document_pages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  document_id uuid not null,
  page        int not null check (page between 1 and 30),
  text        text not null check (char_length(text) <= 20000),
  source      text not null check (source in ('pdf_text', 'ai_transcription', 'manual')),
  extractor   text check (char_length(extractor) <= 80),          -- e.g. 'pdfjs-3.11.174', or the AI model id
  created_at  timestamptz not null default now(),
  unique (document_id, page, source),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade
);
alter table public.document_pages enable row level security;
alter table public.document_pages force row level security;
drop policy if exists "document_pages: owner reads" on public.document_pages;
drop policy if exists "document_pages: owner adds" on public.document_pages;
drop policy if exists "document_pages: owner removes" on public.document_pages;
create policy "document_pages: owner reads" on public.document_pages for select to authenticated using (user_id = auth.uid());
create policy "document_pages: owner adds" on public.document_pages for insert to authenticated with check (user_id = auth.uid());
create policy "document_pages: owner removes" on public.document_pages for delete to authenticated using (user_id = auth.uid());
revoke all on public.document_pages from anon, public;
grant select, insert, delete on public.document_pages to authenticated;

create table if not exists public.document_chunks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  document_id   uuid not null,
  page          int,
  kind          text not null check (kind in ('lab_row', 'medication_line', 'section', 'field', 'page_text', 'transcription')),
  section       text not null,
  parent_key    text not null,                                  -- pieces of one section share it (e.g. a whole lab table)
  position      int not null,
  content       text not null,                                  -- original text, never rewritten
  context       text not null,                                  -- made only from the document's own details
  verification  text not null check (verification in ('confirmed_by_person', 'ai_extracted_unconfirmed', 'document_text')),
  index_version int not null default 1,
  search        tsvector generated always as (to_tsvector('simple', context || ' ' || content)) stored,
  created_at    timestamptz not null default now(),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade
);
create index if not exists document_chunks_search_idx on public.document_chunks using gin (search);
create index if not exists document_chunks_doc_idx on public.document_chunks (user_id, document_id, position);
alter table public.document_chunks enable row level security;
alter table public.document_chunks force row level security;
drop policy if exists "document_chunks: owner reads" on public.document_chunks;
create policy "document_chunks: owner reads" on public.document_chunks for select to authenticated using (user_id = auth.uid());
revoke all on public.document_chunks from anon, public, authenticated;
grant select on public.document_chunks to authenticated;

-- Split text into pieces of at most ~700 characters on line breaks (a line longer than that is cut, never merged).
create or replace function private.split_text(t text, max_len int default 700) returns setof text language plpgsql immutable
  set search_path = pg_catalog as $$
declare line text; buf text := '';
begin
  foreach line in array regexp_split_to_array(coalesce(t, ''), E'\n') loop
    line := btrim(line);
    continue when line = '';
    while char_length(line) > max_len loop
      if buf <> '' then return next buf; buf := ''; end if;
      return next left(line, max_len); line := substr(line, max_len + 1);
    end loop;
    if buf <> '' and char_length(buf) + 1 + char_length(line) > max_len then return next buf; buf := ''; end if;
    buf := case when buf = '' then line else buf || E'\n' || line end;
  end loop;
  if buf <> '' then return next buf; end if;
end $$;

create or replace function private.index_document(p_doc uuid) returns void language plpgsql security definer
  set search_path = public, extensions, pg_temp as $$
declare d public.documents; head text; pos int := 0; k text; v text; x jsonb; t text; pg record; seen text[] := '{}';
begin
  delete from public.document_chunks where document_id = p_doc;
  select * into d from public.documents where id = p_doc;
  if d.id is null then return; end if;
  head := format('%s "%s"%s, %s.', d.category, d.title, coalesce(' from ' || nullif(d.provider, ''), ''),
                 coalesce('dated ' || to_char(d.document_date, 'YYYY-MM-DD'), 'undated'));
  -- values the person confirmed (or typed): a lab table row each, keeping name, value, unit and range together
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(d.fields, '{}'::jsonb)) where jsonb_typeof(value) in ('string', 'number') loop
    pos := pos + 1; seen := seen || lower(k);
    insert into public.document_chunks (user_id, document_id, kind, section, parent_key, position, content, context, verification)
    values (d.user_id, d.id, case when d.category = 'Lab report' then 'lab_row' else 'field' end,
            case when d.category = 'Lab report' then 'Lab results (confirmed by the person)' else 'Details (confirmed by the person)' end,
            d.id || ':confirmed', pos, left(k || ': ' || v, 400), head || ' Section: ' || case when d.category = 'Lab report' then 'lab results' else 'details' end || '.', 'confirmed_by_person');
  end loop;
  -- the AI reading, labelled unconfirmed
  if jsonb_typeof(d.extraction) = 'object' then
    for x in select * from jsonb_array_elements(case when jsonb_typeof(d.extraction->'lab_results') = 'array' then d.extraction->'lab_results' else '[]'::jsonb end) loop
      continue when coalesce(x->>'test', '') = '' or lower(x->>'test') = any (seen);
      pos := pos + 1;
      insert into public.document_chunks (user_id, document_id, kind, section, parent_key, position, content, context, verification)
      values (d.user_id, d.id, 'lab_row', 'Lab results (AI reading, unconfirmed)', d.id || ':ai_labs', pos,
              left(concat_ws(' ', (x->>'test') || ':', x->>'value', nullif(x->>'unit', ''), '(reference ' || nullif(x->>'range', '') || ')', '[' || nullif(x->>'flag', '') || ']'), 400),
              head || ' Section: lab results, AI reading not confirmed by the person.', 'ai_extracted_unconfirmed');
    end loop;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(d.extraction->'medicines') = 'array' then d.extraction->'medicines' else '[]'::jsonb end) loop
      pos := pos + 1;
      insert into public.document_chunks (user_id, document_id, kind, section, parent_key, position, content, context, verification)
      values (d.user_id, d.id, 'medication_line', 'Prescription lines (AI reading, unconfirmed)', d.id || ':ai_meds', pos,
              left(concat_ws(' · ', nullif(x->>'raw', ''), nullif(concat_ws(' ', x->>'name', x->>'strength', x->>'frequency', x->>'timing', x->>'duration'), '')), 400),
              head || ' Section: prescription, AI reading not confirmed by the person.', 'ai_extracted_unconfirmed');
    end loop;
    for k in select unnest(array['diagnoses', 'complaints', 'tests_advised', 'advice']) loop
      continue when coalesce(jsonb_typeof(d.extraction->k), '') <> 'array' or jsonb_array_length(d.extraction->k) = 0;
      pos := pos + 1;
      insert into public.document_chunks (user_id, document_id, kind, section, parent_key, position, content, context, verification)
      values (d.user_id, d.id, 'section', initcap(replace(k, '_', ' ')), d.id || ':ai_' || k, pos,
              left(initcap(replace(k, '_', ' ')) || ': ' || (select string_agg(e, '; ') from jsonb_array_elements_text(d.extraction->k) e), 1200),
              head || ' Section: ' || replace(k, '_', ' ') || ', AI reading not confirmed by the person.', 'ai_extracted_unconfirmed');
    end loop;
    for t in select private.split_text(d.extraction->>'transcription') loop
      pos := pos + 1;
      insert into public.document_chunks (user_id, document_id, kind, section, parent_key, position, content, context, verification)
      values (d.user_id, d.id, 'transcription', 'Transcription (AI reading)', d.id || ':transcription', pos, t,
              head || ' Section: AI transcription of the whole document, page not known.', 'ai_extracted_unconfirmed');
    end loop;
  end if;
  -- page text kept when the document was added
  for pg in select p.page, p.text, p.source from public.document_pages p where p.document_id = d.id order by p.page, p.source loop
    for t in select private.split_text(pg.text) loop
      pos := pos + 1;
      insert into public.document_chunks (user_id, document_id, page, kind, section, parent_key, position, content, context, verification)
      values (d.user_id, d.id, pg.page, 'page_text', 'Page ' || pg.page, d.id || ':page:' || pg.page, pos, t,
              head || ' Page ' || pg.page || '.', case when pg.source = 'ai_transcription' then 'ai_extracted_unconfirmed' else 'document_text' end);
    end loop;
  end loop;
end $$;
revoke all on function private.index_document(uuid) from public, anon, authenticated;
revoke all on function private.split_text(text, int) from public, anon, authenticated;

create or replace function private.reindex_document() returns trigger language plpgsql security definer
  set search_path = public, extensions, pg_temp as $$
begin
  if tg_table_name = 'documents' then
    if tg_op = 'UPDATE' and (new.fields, new.extraction, new.title, new.category, new.document_date, new.provider)
       is not distinct from (old.fields, old.extraction, old.title, old.category, old.document_date, old.provider) then return new; end if;
    perform private.index_document(new.id);
    return new;
  end if;
  -- document_pages: the document may already be gone (deleted with its account or by the person)
  perform private.index_document(coalesce(new.document_id, old.document_id));
  return coalesce(new, old);
end $$;
revoke all on function private.reindex_document() from public, anon, authenticated;
drop trigger if exists documents_index on public.documents;
create trigger documents_index after insert or update on public.documents for each row execute function private.reindex_document();
drop trigger if exists document_pages_index on public.document_pages;
create trigger document_pages_index after insert or delete on public.document_pages for each row execute function private.reindex_document();

-- Full-text candidates for the signed-in person. Each term is one word or a phrase; any term may match.
create or replace function public.search_document_chunks(p_terms text[], p_limit int default 200)
returns table (id uuid, document_id uuid, page int, kind text, section text, parent_key text, content text, context text, verification text, rank real)
language sql stable security invoker set search_path = public, pg_temp as $$
  with q as (
    select to_tsquery('simple', string_agg('(' || phrase || ')', ' | ')) tsq from (
      select string_agg(quote_literal(w), ' <-> ') phrase
      from unnest(p_terms[1:40]) with ordinality as t(term, n),
           lateral (select w from regexp_split_to_table(lower(t.term), '[^a-z0-9]+') w where w <> '') ws
      group by n) p)
  select c.id, c.document_id, c.page, c.kind, c.section, c.parent_key, c.content, c.context, c.verification, ts_rank_cd(c.search, q.tsq)
  from public.document_chunks c, q
  where q.tsq is not null and c.search @@ q.tsq
  order by 10 desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500) $$;
revoke all on function public.search_document_chunks(text[], int) from public, anon;
grant execute on function public.search_document_chunks(text[], int) to authenticated;

create or replace view public.document_index_status with (security_invoker = true) as
  select d.id as document_id, d.title, d.category, d.document_date,
         count(c.id) as chunks,
         count(c.id) filter (where c.kind = 'lab_row') as lab_rows,
         (select count(*) from public.document_pages p where p.document_id = d.id) as pages_with_text,
         d.extraction is not null as has_ai_reading,
         case when count(c.id) > 0 then 'searchable' else 'not_searchable' end as status,
         max(c.created_at) as indexed_at
  from public.documents d left join public.document_chunks c on c.document_id = d.id
  group by d.id;
revoke all on public.document_index_status from anon, public;
grant select on public.document_index_status to authenticated;

-- Index what already exists (runs as the migration owner; each chunk keeps its document's owner).
do $$ declare r record; begin for r in select id from public.documents loop perform private.index_document(r.id); end loop; end $$;
