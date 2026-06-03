import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOPHOST_UPLOAD_ENTRIES, prepareTophostUpload } from '../scripts/prepare-tophost-upload.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tempRoots = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function makeFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecovila-tophost-'));
  tempRoots.push(fixtureRoot);

  fs.writeFileSync(path.join(fixtureRoot, 'index.html'), '<h1>EcoVila</h1>');
  fs.chmodSync(path.join(fixtureRoot, 'index.html'), 0o700);

  fs.mkdirSync(path.join(fixtureRoot, 'assets'));
  fs.writeFileSync(path.join(fixtureRoot, 'assets', 'logo.png'), 'png');
  fs.writeFileSync(path.join(fixtureRoot, 'assets', '.DS_Store'), 'mac');
  fs.chmodSync(path.join(fixtureRoot, 'assets'), 0o700);
  fs.chmodSync(path.join(fixtureRoot, 'assets', 'logo.png'), 0o700);

  fs.mkdirSync(path.join(fixtureRoot, 'admin'));
  fs.writeFileSync(path.join(fixtureRoot, 'admin', 'index.html'), '<h1>Admin</h1>');
  fs.chmodSync(path.join(fixtureRoot, 'admin'), 0o700);
  fs.chmodSync(path.join(fixtureRoot, 'admin', 'index.html'), 0o700);

  fs.mkdirSync(path.join(fixtureRoot, 'docs'));
  fs.writeFileSync(path.join(fixtureRoot, 'docs', 'secret.md'), 'internal');
  fs.writeFileSync(path.join(fixtureRoot, '.env'), 'SECRET=value');

  return fixtureRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('Tophost upload preparation', () => {
  it('exposes a root npm command for preparing the upload folder', () => {
    const manifest = JSON.parse(read('package.json'));

    assert.equal(
      manifest.scripts['prepare:tophost'],
      'node scripts/prepare-tophost-upload.mjs',
    );
  });

  it('ships the static multilingual SEO files and redirect rules', () => {
    assert.deepEqual(
      TOPHOST_UPLOAD_ENTRIES.filter((entry) =>
        ['index.html', 'ru', 'en', 'robots.txt', 'sitemap.xml', 'llms.txt', '.htaccess'].includes(entry)
      ),
      ['index.html', 'ru', 'en', 'robots.txt', 'sitemap.xml', 'llms.txt', '.htaccess'],
    );
    assert.equal(TOPHOST_UPLOAD_ENTRIES.includes('site.html'), false);
  });

  it('copies static files into a clean folder with cPanel-safe permissions', async () => {
    const fixtureRoot = makeFixture();
    const outputDir = path.join(fixtureRoot, 'dist', 'tophost');

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'stale.txt'), 'remove me');

    const result = await prepareTophostUpload({
      rootDir: fixtureRoot,
      outputDir,
      entries: ['index.html', 'assets', 'admin'],
    });

    assert.equal(result.outputDir, outputDir);
    assert.deepEqual(result.copiedEntries, ['index.html', 'assets', 'admin']);

    assert.equal(fs.readFileSync(path.join(outputDir, 'index.html'), 'utf8'), '<h1>EcoVila</h1>');
    assert.equal(fs.readFileSync(path.join(outputDir, 'admin', 'index.html'), 'utf8'), '<h1>Admin</h1>');
    assert.equal(fs.readFileSync(path.join(outputDir, 'assets', 'logo.png'), 'utf8'), 'png');

    assert.equal(fs.existsSync(path.join(outputDir, 'stale.txt')), false);
    assert.equal(fs.existsSync(path.join(outputDir, 'docs', 'secret.md')), false);
    assert.equal(fs.existsSync(path.join(outputDir, '.env')), false);
    assert.equal(fs.existsSync(path.join(outputDir, 'assets', '.DS_Store')), false);

    assert.equal(modeOf(outputDir), 0o755);
    assert.equal(modeOf(path.join(outputDir, 'assets')), 0o755);
    assert.equal(modeOf(path.join(outputDir, 'admin')), 0o755);
    assert.equal(modeOf(path.join(outputDir, 'index.html')), 0o644);
    assert.equal(modeOf(path.join(outputDir, 'assets', 'logo.png')), 0o644);
    assert.equal(modeOf(path.join(outputDir, 'admin', 'index.html')), 0o644);
  });
});
