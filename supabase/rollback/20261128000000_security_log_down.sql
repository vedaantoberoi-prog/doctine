-- Rollback for 20261128000000_security_log.sql. DESTROYS the security log: export it first if it may be needed
-- (it is evidence for CERT-In and DPDP purposes). Needs the owner's explicit approval in production.
drop function if exists public.security_log_add(jsonb);
drop function if exists public.security_log_purge();
drop table if exists private.security_log;
drop function if exists private.security_log_guard();
