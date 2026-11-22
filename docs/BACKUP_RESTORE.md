# Doctine · Backups and restore

## What runs

`.github/workflows/backup.yml` runs every night at 02:10 IST. It dumps the production database (all tables, accounts and file records), encrypts the dump with AES-256 using `BACKUP_PASSPHRASE`, checks that the encrypted copy opens, and keeps it for 30 days as a GitHub Actions artifact named **doctine-db-backup**.

The repository is public, so only the encrypted file ever leaves the runner. Without the passphrase, it can't be read.

**Not included:** the bytes of uploaded photos and PDFs in the `health-documents` bucket. Their records are backed up, but the files themselves aren't. While the bucket is small, download it from Supabase → Storage. For full coverage, move to Supabase Pro, which adds daily backups and optional point-in-time recovery.

## One-time setup (account owner)

1. Supabase → project `doctine-production` → **Connect** → copy the **Session pooler** URI and put the database password in it.
2. GitHub → repository → Settings → Secrets and variables → Actions → **New repository secret**:
   - `SUPABASE_DB_URL` = that URI
   - `BACKUP_PASSPHRASE` = a new random passphrase of at least 32 characters. **Save it in your password manager first.** Without it, the backups can never be opened.
3. Actions → **Nightly backup** → Run workflow. Then check that the run is green and has a `doctine-db-backup` artifact.

## Restore drill (do this once a quarter, never into production)

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
