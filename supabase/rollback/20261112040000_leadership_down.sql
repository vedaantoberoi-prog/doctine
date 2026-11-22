-- Doctine · roll back 20261112040000_leadership.sql (Founder / Co-Founder) to the v2 console roles.
--
-- Order: 1) run this file, 2) re-run supabase/migrations/20261112030000_admin_console_v2.sql (it re-creates the v2 role
-- table and functions), 3) redeploy the app build from before the leadership change.
-- Keeps every row: support requests, feedback, work items, content, invitations and the audit log stay in place (unused).
-- Co-Founders become "admin" if they held flags.manage, "support" if they held support or account permissions,
-- "auditor" if they held audit.view, otherwise "analyst". Review that mapping before running in production.

drop index if exists private.admin_members_one_founder;
do $$ declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'private.admin_members'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%role%' loop
    execute format('alter table private.admin_members drop constraint %I', c);
  end loop;
end $$;
update private.admin_members set role = case
    when role = 'founder' then 'owner'
    when 'flags.manage' = any (permissions) then 'admin'
    when 'users.reset_password' = any (permissions) or 'support.view' = any (permissions) then 'support'
    when 'audit.view' = any (permissions) then 'auditor'
    else 'analyst' end,
  updated_at = now();
-- Functions that only exist for the leadership model; the v2 console never calls them.
do $$ declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('admin_perm_catalog', 'admin_invite_create', 'admin_invite_delivery', 'admin_invite_revoke', 'admin_invite_accept',
             'admin_member_set', 'admin_log_session', 'admin_support', 'admin_support_item', 'admin_support_update', 'admin_support_message', 'admin_feedback',
             'admin_feedback_update', 'admin_work', 'admin_work_save', 'admin_content', 'admin_content_save', 'admin_product_overview',
             'support_submit', 'support_mine', 'support_reply', 'feedback_submit') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
-- Now re-run 20261112030000_admin_console_v2.sql.
