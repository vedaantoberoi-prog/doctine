# Founder and Co-Founder administration — architecture assessment (12 Nov 2026)

Written before any change, as the brief asked.

## How the administrator is identified today

| Mechanism | Used? | Notes |
|---|---|---|
| Database table | **Yes, the only source.** | `private.admin_members (user_id, role, status)`. The `private` schema is not exposed by the Data API. |
| Supabase Auth metadata | No | User metadata is never read for authorisation. |
| Hard-coded email | No | The first owner was created once with SQL; no email appears in code. |
| Front-end conditional | Cosmetic only | The console hides menus the role can't use; every request is re-checked. |

Request path: browser → `/api/admin` (Cloudflare) → the server verifies the Supabase token with `/auth/v1/user`
→ `admin_me` → two-step check → the matching `public.admin_*` database function, run with the server key.
Each function calls `private.require(actor, permission)`, raising 42501 if not allowed, and writes
`private.admin_audit_log` in the same transaction. The audit log refuses UPDATE, DELETE and TRUNCATE through a trigger.
All admin functions can be executed by `service_role` only. Row-level security is on for every private table, with no
policies, so only those functions reach them.

## What exists

- **Roles:** five fixed roles (owner, admin, analyst, support, auditor) in `private.role_perms`. Production has one
  member: the owner (active).
- **Two-step sign-in:** enforced only for admins who have enrolled, or for everyone with `ADMIN_REQUIRE_MFA=true`
  (unset). The owner has no factor.
- **Adding admins:** the owner adds an existing Doctine account by email. There are no invitations and no per-person
  permissions.
- **Sessions:** suspending a person ends their sessions and bans sign-in through the Auth admin API. Supabase
  tokens live 1 hour, and every request is re-checked against the database, so a removed permission applies to the
  next request.
- **Patient data:** no admin function returns record contents, file links, prescriptions, messages or profile
  details (a database test plants marker strings and checks every function).
- **Missing modules:** support requests, product feedback, bugs and tasks, content, release notes, invitation records,
  sign-in and sign-out audit events, and an unauthorised-page screen. Billing, integrations and database management do not exist.

## Gaps against the brief, and the plan

| Brief | Gap | Plan |
|---|---|---|
| Founder and Co-Founder identities | Fixed generic roles | Roles become `founder` (one, enforced by a unique index) and `co_founder`; the owner becomes the Founder |
| Individually configurable permissions | Permissions per role | `admin_members.permissions` per Co-Founder, checked by `private.require`; a permission catalogue marks Founder-only permissions that can never be granted |
| Invitation-only access | Add-existing-account only | `private.admin_invites`, Supabase invite email, acceptance on first sign-in with a verified matching email |
| MFA where feasible | Optional | Required for every admin on the server; the console walks each person through enrolment |
| Support, feedback, bugs, content, releases | Absent | New private tables, admin functions with their own permissions, in-app forms for people (text only, rate-limited) |
| Login/logout and failed-authorisation audit | Failures only | Session sign-in (once per session) and sign-out events; denied page visits |
| Publishing needs explicit permission | One permission for announcements | Drafting (`content.edit`) separate from publishing (`content.publish`, `releases.manage`); clinical content needs a recorded clinical review |
| AI never enabled automatically | Any admin with `flags.manage` | The AI switch becomes Founder-only (`ai.manage`) |
