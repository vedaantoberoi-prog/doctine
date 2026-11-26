# Doctine · Backups and restore

## What runs

`.github/workflows/backup.yml` runs every night at 02:10 IST. It dumps the production database: the health tables (`public`), the app's own records (`private`: Guardian contacts and deliveries, doctor applications, record shares and their access log, the admin audit log, switches), accounts (`auth`) and file records (`storage`), encrypts the dump with AES-256 using `BACKUP_PASSPHRASE`, checks that the encrypted copy opens, and keeps it for 30 days as a GitHub Actions artifact named **doctine-db-backup**.

The repository is public, so only the encrypted file ever leaves the runner. Without the passphrase, it can't be read.

**Before 26 Nov 2026 the `private` schema was missing from the backup.** Backups made before that date cannot restore Guardian contacts, doctor applications, shares or the audit log.

**Uploaded files** (photos, PDFs, doctors' credentials) are copied by a separate nightly job, `.github/workflows/storage-backup.yml`: every file plus a manifest of sizes and SHA-256 hashes, encrypted with the same passphrase, verified file by file after decryption, compared against the database's file records, kept 30 days as **doctine-file-backup**. The key (`STORAGE_BACKUP_KEY`) is in the GitHub environment `backup`, limited to `main`; the first run passed on 26 Nov 2026.

## One-time setup (account owner)

1. Supabase → project `doctine-production` → **Connect** → copy the **Session pooler** URI and put the database password in it.
2. GitHub → repository → Settings → Secrets and variables → Actions → **New repository secret**:
   - `SUPABASE_DB_URL` = that URI
   - `BACKUP_PASSPHRASE` = a new random passphrase of at least 32 characters. **Save it in your password manager first.** Without it, the backups can never be opened.
3. Actions → **Nightly backup** → Run workflow. Then check that the run is green and has a `doctine-db-backup` artifact.

## Automatic restore drill (weekly)

`.github/workflows/restore-drill.yml` runs every Tuesday and on demand. It downloads the newest backup, decrypts it inside the runner and runs `tools/restore-drill.sh`, which:

- builds a throwaway database from the repository's migrations, never from the dump;
- checks the dump holds data for every app table, plus accounts and file records;
- restores all of the app's data and fails on any restore error;
- compares row counts with production, using read-only counts;
- checks that every reference between restored tables resolves and that every medical record belongs to an account in the backup;
- with row-level security on, checks that a restored person sees all of their own records and none of anyone else's, and that a signed-out visitor sees nothing.

The log and summary show only pass or fail. `tests/restore-drill.test.sh` runs in CI with a fictional backup. It proves the drill itself fails when the private schema is missing, when a table's rows are missing, or when an access rule leaks.

The drill does not restore accounts into a working sign-in system. It only checks they are in the backup and match production. It does not cover file bytes. Restoring sign-in for real still needs the manual drill below, into a scratch Supabase project.

## Manual restore drill (once a quarter, never into production)

1. Create a scratch Supabase project, or use `doctine-staging` after confirming it holds nothing you need.
2. Download the artifact from the run, unzip it, then:
   ```
   gpg -d doctine-db-<stamp>.dump.gpg > db.dump          # asks for BACKUP_PASSPHRASE
   pg_restore --list db.dump | head                       # sanity check
   pg_restore --no-owner --no-privileges --data-only --schema=public -d "<scratch project URI>" db.dump
   ```
   Apply the repository's migrations to the scratch project first, so that the tables, RLS and policies exist.
3. Sign in to the scratch project with a fictional test account. Check that row counts match, then delete `db.dump`.
4. Write the date and result in `docs/incidents/` or the release notes.

A real restore follows the same steps, into a **new** project. Switch the app over only after checking it, by changing `SUPABASE_URL` and the keys in Cloudflare.
