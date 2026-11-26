# Staging hosting: Netlify failure and the Vercel option (26 Nov 2026)

Production is not touched by anything here:
- app.doctine.com stays on Cloudflare Pages (`doctine-app-direct`), with the production Supabase project.
- No DNS changes.
- No production secret goes anywhere new.

## 1. Why staging deploys on Netlify stopped

NETLIFY_ROOT_CAUSE

## 2. Is Vercel compatible with Doctine?

**Technically, yes, with one real limit.** The adapter is prepared and tested, but not connected:
- `api/[...path].mjs` sends every `/api/*` request to the **same router production uses on Cloudflare**, so the handlers, routes and checks are identical.
- `vercel.json` serves `public/` with the staging security headers, using the same CSP as the Netlify staging site. The CSP allows only the staging Supabase project.
- The functions run in the Mumbai region (`bom1`).
- `tests/vercel-adapter.test.mjs` runs in CI.

| Area | On Vercel | Notes |
|---|---|---|
| Static app, admin, doctor pages | Yes | `outputDirectory: public` |
| Server functions (Web `Request`/`Response`) | Yes | Vercel's `export default { fetch }` handler. No code changes to the handlers. |
| Client IP for rate limits and the security log | Yes | `x-real-ip`; a visitor-sent `cf-connecting-ip` is dropped. |
| Security headers and CSP | Yes | In `vercel.json` (Vercel doesn't read `_headers`). |
| Region | Mumbai (`bom1`) | Default would be US East (`iad1`). |
| **Request body size** | **4.5 MB by default** | Doctor credential uploads (4 MB files, about 5.4 MB in base64) and scans (up to 6 MB) **will fail with 413**. Vercel's 20 MiB option is a public beta, on Pro only, with 4 GB functions. Otherwise uploads must go directly to Supabase Storage. |
| Work after the reply (security log) | Not wired | Needs the `@vercel/functions` package. Staging doesn't need it. |
| Cron (uptime) | Not needed for staging | — |

## 3. Which Vercel plan

The Hobby plan is **not allowed** for Doctine. Vercel's Terms of Service, section 4, say:

> You shall only use the Services under a Hobby plan for your personal or non-commercial use.

Doctine's staging is part of a commercial product, so it needs **Pro**:
- a **$20/month** platform fee, with 1 deploying seat and $20 usage credit;
- **$20/month** for each further deploying seat (viewer seats are free);
- **$20/month per project** for password protection of previews (optional);
- prices exclude tax.

Nothing has been bought, and no Vercel account or project has been created.

## 4. A safer option than Vercel: staging on Cloudflare Pages too

Production already runs on Cloudflare Pages. A second Pages project, `doctine-staging`, would have these advantages:
- It runs **exactly** the production runtime: the same `_worker.js`, the same 100 MB request limit (so uploads work), and `waitUntil` working. Staging would then test what production runs, which Netlify never did.
- It needs no new vendor, no new plan and no code changes. `npm run build:direct` already builds the zip, and the staging settings go into the new project.
- Production already runs on this account and plan, so staging adds no new vendor terms.
- One thing to watch: on the Workers Free plan, staging would share the account's 100,000 requests a day with production. That's far above today's traffic.

## 5. Safest migration path, whichever host you choose

1. **Keep Netlify staging as it is** until the new site passes every check below. Change nothing in production.
2. **Create the staging project.** On Cloudflare, use your account and a new Pages project `doctine-staging`. On Vercel, it's a Pro team you approve.
3. **Add staging-only variables** to both the production and preview environments of that project:
   - `DOCTINE_ENV=staging`;
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` of `hmlxqmhqfaxfgbizcjyg`;
   - the staging service key;
   - `RATE_LIMIT_SECRET` (a new value);
   - `EVAL_ACCESS_TOKEN` (the same as the staging GitHub environment).

   Never use production values. Previews must use the same staging values, and Vercel previews should be protected with Vercel Authentication.
4. **Deploy and verify with synthetic accounts:**
   - the build, and that `/api/config` answers `staging` with the staging project;
   - sign-in, the health profile and a document upload with a fictional PDF;
   - AI error handling (no key: a clear "not configured" message, and emergency guidance still shown);
   - admin access (sign-in required, MFA);
   - the doctor and sharing switches answer "switched off";
   - production/staging isolation (CSP, config, and the security review's isolation check).
5. **Update the Staging workflow** to deploy there, keeping the same gates.
6. **Only then retire the Netlify site.**

App.doctine.com and the DNS stay as they are throughout.
