-- Rollback for 20261119020000_security_hardening.sql: removes the fixed search_path from functions that have exactly the
-- one it set, and restores EXECUTE on log_consent(). Security-definer functions keep their own settings.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and not p.prosecdef
      and 'search_path=public, extensions, pg_temp' = any(coalesce(p.proconfig, '{}'))
  loop
    execute format('alter function %s reset search_path', f.sig);
  end loop;
end $$;
grant execute on function public.log_consent() to public;
