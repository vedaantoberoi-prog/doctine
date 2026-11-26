-- Rollback for 20261129000000_ai_provider_checks.sql. Removes the record of AI provider checks (operational data only:
-- no person's data). Production needs the owner's approval like any schema change.
drop function if exists public.admin_ai_provider_checks(uuid);
drop function if exists public.ai_provider_check_add(jsonb);
drop table if exists private.ai_provider_checks;
