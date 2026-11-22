-- Rollback of 20261123010000_evidence_index.sql. Removes the evidence index and kept page text (documents themselves,
-- their files, AI readings and lab results are untouched). The page text cannot be rebuilt afterwards: back it up first.
drop view if exists public.document_index_status;
drop function if exists public.search_document_chunks(text[], int);
drop trigger if exists document_pages_index on public.document_pages;
drop trigger if exists documents_index on public.documents;
drop function if exists private.reindex_document();
drop function if exists private.index_document(uuid);
drop function if exists private.split_text(text, int);
drop table if exists public.document_chunks;
drop table if exists public.document_pages;
