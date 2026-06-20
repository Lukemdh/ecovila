#!/usr/bin/env bash
#
# Full Supabase backup -> Google Drive + OneDrive (via rclone).
#
# Produces a single dated tarball containing:
#   roles.sql        - custom DB roles (best-effort)
#   schema.sql       - full schema (tables, functions, policies, triggers)
#   data.sql         - all table data
#   reservations.csv - human-readable copy of public.reservations
#
# ...then uploads the tarball + a standalone reservations.csv to every
# configured rclone remote, and prunes anything older than RETENTION_DAYS.
#
# Runs in CI (see .github/workflows/backup.yml) or locally. See docs/BACKUP_SETUP.md.
#
# Required env:
#   SUPABASE_DB_URL   Postgres connection string. In CI use the *Session Pooler*
#                     string (IPv4) from Supabase -> Project Settings -> Database.
#
# Optional env:
#   REMOTES           Space-separated rclone remote names. Default: "gdrive onedrive"
#   REMOTE_PATH       Folder on each remote.              Default: "EcoVila-Backups"
#   RETENTION_DAYS    Delete backups older than this.     Default: "90"
#   RCLONE_CONFIG     Path to rclone.conf (CI sets this). Default: rclone's own default
#
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL (use the Session Pooler connection string)}"
REMOTES="${REMOTES:-gdrive onedrive}"
REMOTE_PATH="${REMOTE_PATH:-EcoVila-Backups}"
RETENTION_DAYS="${RETENTION_DAYS:-90}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="ecovila-backup-${TS}.tar.gz"
CSV="reservations-${TS}.csv"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

echo "==> Dumping database (project: ecovila) ..."
# Roles can require elevated perms; never let it sink the whole backup.
supabase db dump --db-url "$SUPABASE_DB_URL" --role-only -f roles.sql \
  || echo "WARN: roles dump skipped (no custom roles or insufficient perms)"
supabase db dump --db-url "$SUPABASE_DB_URL"             -f schema.sql
supabase db dump --db-url "$SUPABASE_DB_URL" --data-only -f data.sql

echo "==> Exporting public.reservations to CSV ..."
psql "$SUPABASE_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "\copy (select * from public.reservations order by 1) to stdout with csv header" \
  > "$CSV"

echo "==> Packing archive ..."
cp "$CSV" reservations.csv
tar czf "$ARCHIVE" roles.sql schema.sql data.sql reservations.csv 2>/dev/null \
  || tar czf "$ARCHIVE" schema.sql data.sql reservations.csv   # roles.sql may be absent
rm -f reservations.csv

echo "==> Archive: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1)), CSV rows: $(($(wc -l < "$CSV") - 1))"

for remote in $REMOTES; do
  dest="${remote}:${REMOTE_PATH}"
  echo "==> Uploading to ${dest} ..."
  rclone copyto "$ARCHIVE" "${dest}/${ARCHIVE}" --no-traverse
  rclone copyto "$CSV"     "${dest}/csv/${CSV}" --no-traverse

  echo "==> Pruning >${RETENTION_DAYS}d on ${dest} ..."
  rclone delete "$dest" --min-age "${RETENTION_DAYS}d" --rmdirs
done

echo "==> Done."
