-- Doctine · security hardening from the Supabase security advisor (19 Nov 2026). No data or behaviour changes.
-- 1. Every function in public and private gets a fixed search_path, so a schema created later can never change which
--    tables or functions it reaches ("function_search_path_mutable"). Security-definer functions already had one.
--    The path is the one these functions already ran with (public, then extensions), plus pg_temp last.
-- 2. public.log_consent() is a trigger function; nobody needs to call it directly. Triggers keep working without the
--    EXECUTE right ("anon_security_definer_function_executable").
-- Rollback: supabase/rollback/20261119020000_security_hardening_down.sql

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and p.prokind = 'f'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')   -- skip extension-owned functions
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', f.sig);
  end loop;
end $$;

revoke execute on function public.log_consent() from public, anon, authenticated;
