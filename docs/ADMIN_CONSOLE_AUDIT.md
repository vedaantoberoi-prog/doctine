# Admin console — audit and redesign plan (12 Nov 2026)

Written before the redesign, as the brief asked: what each section was, where its numbers come from, what was missing,
and what changed. "v1" is the console live at app.doctine.com/admin (release ef60008). "v2" is this redesign.

## Stack found

- Front end: vanilla JavaScript, no framework or chart library. `public/admin/index.html`, `admin.css`, `admin.js`,
  hash routing (`#/users`), served under a stricter CSP than the app (no inline script). The redesign keeps this — no new
  dependencies; charts are hand-built SVG.
- Server: `/api/admin` (`netlify/functions/admin.mjs`, routed by the Cloudflare Pages function). It verifies the
  Supabase token, checks MFA, rate-limits, then calls a `public.admin_*` database function with the service key.
- Database: `private` schema (not exposed by the Data API) holding admin members, settings, audit log, events, errors,
  uptime checks, alerts, incidents, announcements. Every `admin_*` function checks the role (`private.require`) and
  writes the audit log in the same transaction. The audit log refuses UPDATE/DELETE/TRUNCATE through a trigger.
- Measurements: account, record, file, medicine and dose counts come from existing tables. Feature events (PDF read,
  search, export, upload/reading outcomes) come from `/api/events`, only for signed-in people who opted in.
- Roles in v1: owner, super_admin, operations, analyst, support, developer.

## Mapping

| Admin section | Existing implementation (v1) | Data source | Missing functionality | Improvement made (v2) |
|---|---|---|---|---|
| Dashboard | 8 KPI tiles, 2 charts, period buttons (7/30/90 days) | `admin_overview`, `admin_series` (auth.users, records, files, activity view, events) | No previous-period comparison, no sparklines, DAU/WAU/MAU not separate, no availability or error KPIs, no activity panels; zero and "not measured" looked alike | 12 KPI cards with previous-period comparison ("New" instead of a fake %), sparklines, explanations, click-through; six value states with `data-state`; graphs A–F with tabs, previous-period line, tooltips, table view; six activity panels |
| Analytics | Funnel (4 steps), adoption table, retention cohorts | `admin_funnel`, `admin_adoption`, `admin_retention` | Acquisition KPIs, 6-step activation, engagement section, adoption trend, honest "Not measured" per feature | Acquisition, Activation (6 steps with drop-offs), Engagement (`admin_engagement`), Adoption (measured/source per feature, `admin_adoption_trend`), Retention with written definition |
| Reports | CSV export of daily figures, PDF summary | `admin_series` → CSV; `makePdf` | Only one report; no comparison; no history | 9 report types + account list, CSV and PDF, each with previous-period comparison; every export logged (requested → ok/failed) and listed in export history (`admin_exports`) |
| Users | Search, status filter, paging | `admin_users`, `admin_user` | Registration date filter, sorting by activity/records, page size, column visibility, CSV, sign-in methods, MFA, adoption flags | All added; drawer shows metadata, sign-in methods, usage counts, adoption, security events, notes; no health data |
| Documents | Counts by source/category/type, failure codes | `admin_documents` (records, files, events) | Storage remaining and threshold, operations table, PDF success/failure | Capacity meter against the 1 GB Supabase Free limit, warning at 80 % and critical at 95 % (alerts open at the same points), pseudonymous operations table (md5 code, never the email), outcomes marked "Not measured" until events arrive |
| Platform health | Live checks of app, DB, auth, storage; uptime strip | `/api/admin health` → `record_uptime`; `admin_uptime` | AI provider state, monitoring-job card, response-time and failure charts, recent-checks table, error codes | All added; AI shows Operational / Configured but failing / Disabled by switch / Not configured; Down if the latest check failed, Degraded if slow or failed in 24 h |
| Errors | Grouped errors, resolve/ignore | `report_error`, `admin_errors` | 24h/7d/30d counts, categories, stack, route, correlation ID | Counts, daily chart, category filter, drawer with cleaned stack, route, environment, release, request ID |
| Incidents | Title, status, notes | `admin_incident_save` | Severity, assignee, timeline | Severity, assigned admin, timeline of every change (`incident_updates`) |
| Alerts | Open / acknowledged / resolved, rule table | `evaluate_alerts`, `raise_alert` | Mute, affected service, recommended action, monitoring-job alert, honest email status | Mute 24 h (reopens automatically), service, recommended action per rule, `monitor_stale` and `down_ai` rules; email shown as "Not configured" unless Resend is set |
| Feature switches | Toggles with reason + audit | `admin_set_flag`, `public_settings` | Effects, dependencies, layer, last changed by, propagation | Cards with on/off effects, dependencies, layer, last change; after a change the console polls the live `/api/config` and shows "Live in the app" or "Not confirmed yet" |
| Maintenance | On/off with message | `maintenance` setting | Scheduling, preview | Now or a start–end window (IST), enforced in the database (`maintenance_on()`), live preview; also shown on the app's sign-in screen |
| Announcements | Draft/publish with dates | `admin_announcement_save` | Audience, unpublish | Audience (everyone / signed-in only), preview, unpublish; start/end dates are enforced by the database (`public_settings` only returns announcements inside their window) |
| Admin team | Add, change role, suspend, remove | `admin_team`, `admin_team_set` | New role set, last admin action, who added | Five roles (owner, admin, analyst, support, auditor), role descriptions, added by, last sign-in, last admin action |
| Audit log | Filterable list, CSV | `admin_audit` | Previous → new state column | Before/after shown, filters, export; still append-only |
| Security events | Refusals, login failures | `admin_security` | — | Same data, redesigned; admins without MFA highlighted |
| Metric definitions | Text page | static | DAU/WAU/MAU windows, availability, upload/PDF success | Definitions for every KPI including value states and the earliest measurement dates |

## Data honesty rules applied

- A figure is shown only from a database query. Unmeasured → "Not measured"; nothing recorded yet → "Insufficient data";
  missing configuration → "Not configured"; request failed → "Unavailable"; zero is drawn as zero.
- Comparison shows "New" when the previous period had nothing, and nothing at all when it has no data.
- Charts that would be all zero say so instead of drawing a flat line.
- No synthetic data in staging or production metrics; tests use fictional `@example.test` accounts in rolled-back transactions.
