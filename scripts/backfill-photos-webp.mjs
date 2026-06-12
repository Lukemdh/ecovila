// One-off backfill: shrink every existing photo in the `ecovila-photos` bucket
// to a small WebP, overwriting each object in place.
//
// Why in place (same path/extension): publish_crm_photos() regenerates the
// published rows from drafts by copying storage_path, and the frontend builds
// every URL from storage_path. Renaming would mean touching both the DB rows
// and the publish flow. Overwriting the bytes and setting Content-Type to
// image/webp leaves all of that untouched — Supabase serves by stored
// content-type, so a `.jpg`-named object full of WebP bytes renders fine.
//
// On the Free plan render-time transforms are ignored, so these originals are
// exactly what visitors download — shrinking them is the actual speed win.
//
// Idempotent: an object already WebP and <= MAX_EDGE on its long side is left
// alone, so re-running (or running after new admin uploads) is safe.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-photos-webp.mjs [--dry-run]

import sharp from 'sharp';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'ecovila-photos';
const MAX_EDGE = 2000;
const WEBP_QUALITY = 82;
const CACHE_CONTROL = '31536000';
const DRY_RUN = process.argv.includes('--dry-run');

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
};

// Collect every storage_path the CRM references (draft + published rows share
// paths, so dedupe). This is the authoritative set of files in use.
async function listReferencedPaths() {
  const url = `${SUPABASE_URL}/rest/v1/crm_photos?select=storage_path`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to list crm_photos: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  return [...new Set(rows.map((row) => row.storage_path).filter(Boolean))].sort();
}

async function downloadObject(path) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`download ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadObject(path, buffer) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`;
  const response = await fetch(url, {
    method: 'PUT', // upsert existing object
    headers: {
      ...headers,
      'Content-Type': 'image/webp',
      'Cache-Control': CACHE_CONTROL,
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!response.ok) {
    throw new Error(`upload ${response.status} ${await response.text()}`);
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

async function run() {
  const paths = await listReferencedPaths();
  console.log(`${paths.length} unique storage objects referenced.${DRY_RUN ? ' (dry run)' : ''}\n`);

  let shrunk = 0;
  let skipped = 0;
  let failed = 0;
  let savedBytes = 0;

  for (const path of paths) {
    try {
      const original = await downloadObject(path);
      const meta = await sharp(original).metadata();
      const longEdge = Math.max(meta.width || 0, meta.height || 0);

      if (meta.format === 'webp' && longEdge <= MAX_EDGE) {
        skipped += 1;
        console.log(`skip   ${path} (already webp ${meta.width}x${meta.height})`);
        continue;
      }

      const webp = await sharp(original, { failOn: 'none' })
        .rotate() // bake in EXIF orientation before the tag is dropped
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();

      savedBytes += original.length - webp.length;
      console.log(`${DRY_RUN ? 'would ' : 'shrink'} ${path}  ${kb(original.length)} -> ${kb(webp.length)} (${meta.format} ${meta.width}x${meta.height})`);

      if (!DRY_RUN) {
        await uploadObject(path, webp);
      }
      shrunk += 1;
    } catch (error) {
      failed += 1;
      console.error(`FAIL   ${path}: ${error.message}`);
    }
  }

  console.log(`\nDone. shrunk=${shrunk} skipped=${skipped} failed=${failed} saved=${(savedBytes / 1048576).toFixed(1)}MB`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
