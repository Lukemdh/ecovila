# Off-platform database backups (Google Drive + OneDrive)

A daily GitHub Actions job dumps the Supabase database and the `reservations`
table and copies them to **both** Google Drive and OneDrive — your own,
off-platform layer on top of Supabase's built-in backups.

- Workflow: [`.github/workflows/backup.yml`](../.github/workflows/backup.yml)
- Script: [`scripts/backup-supabase.sh`](../scripts/backup-supabase.sh)
- Schedule: 02:30 UTC daily (plus a manual "Run workflow" button)
- Retention: deletes copies older than 90 days on each drive

Each run uploads to `EcoVila-Backups/` on each drive:

- `ecovila-backup-<timestamp>.tar.gz` — `roles.sql` + `schema.sql` + `data.sql` + `reservations.csv` (full disaster-recovery set)
- `csv/reservations-<timestamp>.csv` — standalone, double-click-to-open copy of all bookings

> ⚠️ **These files contain guest PII** (names, phones, emails) and are **not
> encrypted**. Keep both Drive folders private (don't share the link), and
> only grant access to people who need it. To add encryption later, switch the
> remotes to an [rclone crypt](https://rclone.org/crypt/) wrapper — the script
> needs no changes.

---

## One-time setup (~15 min)

You do this once on your Mac. Two of the steps need *your* Google / Microsoft
login, so they can't be automated.

### 1. Install and authorize rclone

```bash
brew install rclone        # or: curl https://rclone.org/install.sh | sudo bash
rclone config
```

In the interactive prompt, create **two remotes** with these exact names:

- `gdrive`  → storage type **Google Drive** (`drive`)
- `onedrive` → storage type **Microsoft OneDrive** (`onedrive`)

For each, accept the defaults and let it open a browser to log in. When done,
`rclone listremotes` should print:

```
gdrive:
onedrive:
```

Quick sanity check that both can write:

```bash
echo hello | rclone rcat gdrive:EcoVila-Backups/_test.txt
echo hello | rclone rcat onedrive:EcoVila-Backups/_test.txt
rclone delete gdrive:EcoVila-Backups/_test.txt
rclone delete onedrive:EcoVila-Backups/_test.txt
```

### 2. Get the Supabase Session Pooler connection string

Supabase dashboard → **Project Settings → Database → Connection string →
Session pooler**. Copy it and put your DB password in place of `[YOUR-PASSWORD]`.

> Use the **Session pooler** string, not the direct one. GitHub's runners are
> IPv4-only and the direct connection is IPv6 — the dump would fail to connect.

It looks like:
`postgresql://postgres.mckchrviaawdxtsfytut:[PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`

### 3. Add the two GitHub repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name         | Value                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `SUPABASE_DB_URL`   | the Session Pooler string from step 2                            |
| `RCLONE_CONF_BASE64`| base64 of your rclone config (command below)                     |

Generate the rclone secret (copies it to your clipboard on macOS):

```bash
base64 -i ~/.config/rclone/rclone.conf | pbcopy
```

### 4. Test it

Repo → **Actions → "Supabase backup" → Run workflow**. After it goes green,
check that `EcoVila-Backups/` exists in both Google Drive and OneDrive with a
fresh tarball and a `csv/` file.

You can also run it from your Mac:

```bash
export SUPABASE_DB_URL='postgresql://...pooler.supabase.com:5432/postgres'
bash scripts/backup-supabase.sh
```

---

## Restoring from a backup

1. Download and unpack a tarball: `tar xzf ecovila-backup-<timestamp>.tar.gz`
2. Into a fresh/empty database (use the Session Pooler URL):

```bash
psql "$SUPABASE_DB_URL" -f roles.sql      # if present
psql "$SUPABASE_DB_URL" -f schema.sql
psql "$SUPABASE_DB_URL" -f data.sql
```

For just the bookings, `reservations.csv` opens directly in Excel / Sheets, or
re-import with `\copy public.reservations from 'reservations.csv' csv header`.

## Tuning

Edit the `env:` block in [`backup.yml`](../.github/workflows/backup.yml):

- `RETENTION_DAYS` — how long copies are kept
- `REMOTES` — drop to `"gdrive"` or `"onedrive"` to use only one
- the `cron:` line — change frequency (e.g. `0 */6 * * *` for every 6 hours)
