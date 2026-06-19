import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPHOST_UPLOAD_ENTRIES } from './prepare-tophost-upload.mjs';

// Site-wide cache-busting: stamp a shared ?v=<version> onto every LOCAL <link>
// stylesheet and <script> reference in the shipped HTML so a returning visitor's
// browser refetches CSS/JS instead of serving a stale cached copy. A single
// shared token (not per-file hashes) is deliberate — bumping it forces a refresh
// of every asset at once, which is the intended "everyone sees the new build"
// behaviour. Re-run on each deploy that changes CSS/JS.
//
// Reusable from the CLI:  node scripts/stamp-asset-versions.mjs [version]
// (defaults to today's date, YYYYMMDD).

// href="..."/src="..." pointing at a LOCAL .css or .js file. The optional third
// group captures an existing ?v= token so re-runs REPLACE it in place rather than
// stacking ?v=...?v=...; external URLs are filtered out in the replacer.
const ASSET_REF = /(\b(?:href|src)=")([^"]+?\.(?:css|js))(\?v=[^"]*)?(")/gi;

function isExternal(url) {
  // Absolute (http:, https:, file: …), protocol-relative (//cdn…) or data: URIs
  // live on other caches and must never be rewritten.
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('data:');
}

export function stampHtml(html, version) {
  let count = 0;
  const out = html.replace(ASSET_REF, (match, pre, url, _existing, post) => {
    if (isExternal(url)) {
      return match;
    }

    count += 1;
    return `${pre}${url}?v=${version}${post}`;
  });

  return { html: out, count };
}

// Returns the local css/js references in `html` that are missing a ?v= token.
// Used by the test suite to guard against an unversioned asset slipping into a
// shipped page (which would let stale caches win for that file).
export function findUnversionedAssetRefs(html) {
  const refs = [];

  for (const [, , url, existing] of html.matchAll(ASSET_REF)) {
    if (!isExternal(url) && !existing) {
      refs.push(url);
    }
  }

  return refs;
}

export function defaultVersion(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

// Walk the TopHost deploy entries and collect every shipped *.html document, so
// the stamper can never drift from what prepare-tophost-upload.mjs actually
// ships (root pages + en/ + ru/ + admin/).
export async function collectHtmlFiles(rootDir, entries) {
  const files = [];

  const visit = async (relPath) => {
    const absPath = path.join(rootDir, relPath);
    const stats = await stat(absPath);

    if (stats.isDirectory()) {
      for (const name of await readdir(absPath)) {
        await visit(path.join(relPath, name));
      }
      return;
    }

    if (stats.isFile() && relPath.endsWith('.html')) {
      files.push(relPath);
    }
  };

  for (const entry of entries) {
    await visit(entry);
  }

  return files.sort();
}

export async function stampAssetVersions({
  rootDir = process.cwd(),
  version = defaultVersion(),
  entries = TOPHOST_UPLOAD_ENTRIES,
} = {}) {
  const htmlFiles = await collectHtmlFiles(rootDir, entries);
  const results = [];

  for (const relPath of htmlFiles) {
    const absPath = path.join(rootDir, relPath);
    const original = await readFile(absPath, 'utf8');
    const { html, count } = stampHtml(original, version);
    const changed = html !== original;

    if (changed) {
      await writeFile(absPath, html);
    }

    results.push({ file: relPath, refs: count, changed });
  }

  return {
    version,
    files: results,
    totalRefs: results.reduce((sum, result) => sum + result.refs, 0),
  };
}

function isCliEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }

  return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isCliEntrypoint()) {
  const version = process.argv[2] || defaultVersion();
  const result = await stampAssetVersions({ version });

  for (const file of result.files) {
    console.log(`${file.changed ? 'stamped' : ' same  '} ${file.file} (${file.refs} refs)`);
  }

  console.log(
    `\nAsset version ?v=${result.version} applied across ${result.files.length} HTML files, ` +
      `${result.totalRefs} references.`,
  );
}
