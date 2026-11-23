-- Rollback of 20261123050000_ai_traces.sql: removes the assistant's stored traces and their two functions.
-- No health data is involved; the app keeps working (traces then exist only as log lines).
drop function if exists public.admin_ai_traces(uuid, int);
drop function if exists public.record_ai_trace(jsonb);
drop table if exists private.ai_traces;
