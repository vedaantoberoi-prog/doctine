-- Minimal stand-ins for the parts of Supabase the migrations rely on (auth.uid, auth.users, auth.sessions, auth.mfa_factors,
-- storage), for local testing only. Column names and types follow Supabase's own auth and storage schemas.
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if; end $$;
create schema auth; create schema storage;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), email_confirmed_at timestamptz,
  last_sign_in_at timestamptz, banned_until timestamptz, is_anonymous boolean not null default false, deleted_at timestamptz);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz default now());
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, status text not null);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.objects enable row level security;
grant usage on schema auth, storage, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
