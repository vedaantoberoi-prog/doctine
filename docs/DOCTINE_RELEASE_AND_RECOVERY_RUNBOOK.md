# Doctine — release and recovery runbook

This runbook is the single checklist for changing production and for getting it back. The details it points to live in
`DEPLOY.md` (build and upload), `docs/BACKUP_RESTORE.md` (backups) and `docs/INCIDENT_RESPONSE.md` (people and
notifications). It doesn't repeat them.

**Rules that always apply.**
- Nothing reaches production without the owner's explicit approval of that commit.
- There are no destructive migrations in a routine release.
- A security hotfix carries no unrelated changes.
- Never paste a secret into chat, a ticket or a log.

## Release checklist (every production change)

| # | Step | How | Evidence to keep |
|---|---|---|---|
| 1 | Confirm what's live | Cloudflare → `doctine-app-direct` → Deployments (production, with the app.doctine.com alias); `https://app.doctine.com/version.json` | Deployment id and commit |
| 2 | Confirm the database state | Run the fingerprint queries in `DOCTINE_CURRENT_STATE_AUDIT.md` §4 on production and staging, and compare with a database built from the migrations | Matching hashes |
| 3 | Confirm a rollback path | One earlier deployment exists and answers 421 at its own address (see the check in `DEPLOY.md` §16) | Its id |
| 4 | Smallest safe change | One PR per concern | PR link |
| 5 | Tests | CI on the PR: code quality, security checks, backend, database (including the restore-drill test), browser. Or locally, `DEPLOY.md` §17. | Green CI run |
| 6 | Security checks | gitleaks, secret scan, `npm audit`, CSP tests (in CI) | Same run |
| 7 | Review the diff | No secrets, no switch flipped by accident, no migration you didn't intend | PR review |
| 8 | Staging | Merge to `main`; the Staging workflow deploys to doctine-staging.netlify.app | Staging run |
| 9 | Synthetic data on staging | Staging end-to-end with synthetic accounts. For access changes, repeat the two-account test from the security review (and delete the accounts after). | Run summary |
| 10 | Switches | Admin console → Switches, on both. A new feature ships **off**. | Screenshot or query |
| 11 | Database isolation | Each environment's `/api/config` names only its own Supabase project; the CSP allows only that host (`tests/browser/csp.test.mjs`) | Probe output |
| 12 | The exact artifact | `npm run build:direct` at the approved commit. Record the SHA-256 of `dist/doctine-app.zip` and check it again just before the upload. | Hash |
| 13 | Deploy | Only after 1–12 pass and the owner has approved: upload the zip (`DEPLOY.md` §16) | Deployment id |
| 14 | Verify live | `version.json` shows the commit; `/api/monitor` is ok; key flows are smoke-checked; the old deployment answers 421 | Probe output |
| 15 | Record | Commit, deployment id, hash and checks, in the release notes or the PR | — |
| 16 | Keep a rollback | Delete deployments older than the previous one (`DEPLOY.md` §16). Keep exactly one rollback target. | Inventory |

### Database migrations

1. Every migration comes with a rollback file in `supabase/rollback/`. It must pass `bash tests/run-db-tests.sh`.
2. Apply it to **staging** first, then check the fingerprint matches a locally built database.
3. Production only with the owner's explicit approval words. Apply it inside a single transaction
   (`begin; … commit;`) from the exact file at the approved commit, after checking its SHA-256.
4. Check the fingerprint again. A migration that drops or rewrites data is **not** routine: it needs a separate plan, a
   fresh backup and a passing restore drill the same day.

## Recovery

| Situation | First action | Then |
|---|---|---|
| A bad release (errors, broken flow) | Cloudflare → `doctine-app-direct` → Deployments → the previous deployment → **Rollback** | Check `version.json` and `/api/monitor`; fix forward through the checklist |
| A bad migration | Stop writes if needed (admin → Switches → `maintenance`) | Apply its rollback file the same way (one transaction, hash-checked); compare fingerprints |
| An old deployment reachable with production keys | Delete it (Deployments → ⋯ → Delete) | Check that it returns 404; record it in the security review |
| A leaked key or secret | Rotate it at the source (Supabase API keys, Cloudflare variables, GitHub secrets), then upload the zip again, because variables apply only to new deployments | Follow `INCIDENT_RESPONSE.md` (containment, CERT-In within 6 hours if it applies); review the admin audit log |
| Data lost or corrupted in the database | Don't write over production. Download the newest `doctine-db-backup` artifact. | Restore into a **new** Supabase project (`BACKUP_RESTORE.md`), check it, then switch `SUPABASE_URL` and the keys in Cloudflare and upload again |
| Uploaded files lost | **No backup of file bytes exists.** Supabase support, or the Pro plan's backups if bought before the loss. | Owner decision: Pro, or a storage sync job |
| Supabase project down | Status page; the app shows its own error | Nothing to fail over to; tell users through the website |
| Cloudflare account lost | The account owner's recovery | Re-create the Pages project from `DEPLOY.md` §16 and the secret names in `DOCTINE_CURRENT_STATE_AUDIT.md` |

## Proof that recovery works

- **Backups:** nightly at 02:10 IST. The job fails if the private schema is missing, or if the encrypted copy doesn't
  decrypt to exactly the dump.
- **Restore drill:** weekly (Tuesdays) and on demand, Actions → **Backup restore drill**. It restores the newest real
  backup into a throwaway database and checks counts, references, record owners and row-level security. The first
  passing run on the full backup was on 26 Nov 2026 (run 45800576737).
- **Not yet rehearsed:** restoring sign-in into a new Supabase project, and recovering file bytes. Do the manual drill in
  `BACKUP_RESTORE.md` once a quarter.
