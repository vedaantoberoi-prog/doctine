# Doctine · Incident response

What to do when something goes wrong with health data, accounts, or the live service.
Keep this short enough to follow at 2 a.m. Review it every three months and after every incident.

## 1. What counts as an incident

| Severity | Examples | Start within |
|---|---|---|
| **SEV-1: data exposure** | One person can see another's records. A secret key is leaked (in git, a log, a screenshot or chat). The storage bucket is public. Someone unknown is using the Supabase dashboard. | Immediately |
| **SEV-2: integrity or access** | Records are changed or deleted unexpectedly. Sign-in is broken for everyone. The AI gives unsafe medical advice that bypasses the emergency rules. | Within 1 hour |
| **SEV-3: degraded service** | The app or website is down or slow. AI reading fails. Emails don't arrive. | Same day |

If you're unsure, treat it as one level more serious.

## 2. First hour: contain

1. **Write down the time** you noticed and what you saw. Keep a running log (the template is in section 6). Take screenshots and don't delete anything.
2. **Stop the leak first, investigate second:**
   - **Leaked Supabase secret or service key:** Supabase dashboard → Project settings → API keys → revoke it and create a new one. Update `SUPABASE_SERVICE_ROLE_KEY` in the Cloudflare Pages project (`doctine-app-direct` → Settings → Variables), then redeploy.
   - **Leaked Anthropic key:** console.anthropic.com → API keys → disable it. Set a new `ANTHROPIC_API_KEY` in Cloudflare, or leave it unset to keep the AI off.
   - **Cross-account exposure:** turn the AI off by removing `ANTHROPIC_API_KEY`. If records are exposed, put the app into maintenance by rolling back to the last good deployment (Cloudflare → Deployments → … → Rollback). Don't edit RLS policies live without a reviewed migration.
   - **Unknown dashboard access:** change the Supabase, Cloudflare and GitHub passwords. Sign out all sessions and check that 2FA is on for each.
   - **Bad deployment:** Cloudflare Pages → Deployments → choose the previous production build → **Rollback**. This takes seconds.
3. **Preserve evidence:** export the Supabase auth and API logs, and the Cloudflare deployment history, for the affected window.

## 3. Within 6 hours: report, if required

India has strict timelines. Confirm the current rules with a lawyer; this section is a checklist, not legal advice.

- **CERT-In:** certain cyber incidents (including data breaches and unauthorised access to systems) must be reported within **6 hours** of noticing them. Use incident@cert-in.org.in and see cert-in.org.in for the form.
- **DPDP Act 2023 / DPDP Rules:** a personal-data breach must be reported to the **Data Protection Board** and to **each affected person**, without delay. A detailed report to the Board follows within 72 hours. Check which provisions are in force on the date of the incident.
- **Processors:** if the cause sits with Supabase, Cloudflare, Anthropic or the email provider, open a ticket with them and record the ticket number.

The message to affected people should cover what happened, what data was involved, what we have done, what they can do (for example, change their password), and how to reach us at support@doctine.com. Plain words, no blame-shifting.

## 4. Recover

1. Fix the cause through the normal process: branch → tests (`npm test`, `node tools/run-browser-tests.mjs`, `bash tests/run-db-tests.sh`) → preview deployment → production.
2. Add a test that would have caught it.
3. If data was lost, restore from Supabase backups. **Test a restore into a separate project first**, never over production.
4. Confirm that the fix works in production with fictional test accounts only.

## 5. Afterwards (within 5 days)

Write a short postmortem: timeline, cause, impact (how many people, which data), what worked, what didn't, and actions with an owner and a date. Keep it in `docs/incidents/YYYY-MM-DD-<name>.md`. Don't put personal data in it.

## 6. Incident log template

```
Incident: <short name>        Severity: SEV-?        Lead: <name>
Noticed: <date time IST>      By: <who / how>
Timeline (IST):
  hh:mm  ...
Systems: app / website / Supabase / storage / AI / email
Data involved: <categories, approximate number of people>  (no actual records here)
Reported to: CERT-In <time, ref> · DPB <time, ref> · users <time>
Status: contained / resolved
```

## 7. Monitoring that makes incidents visible (to set up)

These are dashboard settings; each needs the account owner.

- **Uptime:** a free external check every 5 minutes on `https://app.doctine.com/` and `https://doctine.com/`, alerting by email (UptimeRobot, Better Stack or similar).
- **Cloudflare:** Notifications → turn on Pages deployment-failure alerts for both projects.
- **Supabase:** check the auth logs weekly for bursts of failed sign-ins. Set usage and spend alerts.
- **Anthropic:** set a monthly spend limit and an email alert before the AI is switched on.
- **GitHub:** keep secret scanning and Dependabot alerts on.

## Contacts

| Role | Who | How |
|---|---|---|
| Incident lead | Founder | — |
| Legal (DPDP / CERT-In) | _to be named_ | — |
| Clinical safety (AI advice issues) | _to be named_ | — |
| Supabase / Cloudflare / Anthropic support | dashboard support pages | — |
