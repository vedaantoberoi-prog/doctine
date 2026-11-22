-- Doctine · row-level security on the admin console's private tables (defence in depth).
-- These tables are already unreachable from browsers: the `private` schema is not exposed by the Data API and no browser
-- role has any privilege on it. Enabling RLS with no policies means that, even if a privilege were granted by mistake,
-- signed-in and anonymous roles would still see no rows. Not FORCED: the security-definer admin functions run as the
-- table owner and the server role bypasses RLS, so nothing the console does changes. Additive and re-runnable.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relkind = 'r' loop
    execute format('alter table private.%I enable row level security', t.relname);
  end loop;
end $$;
