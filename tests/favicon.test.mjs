import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shippedPages = [
  'index.html',
  'site.html',
  'rezervari.html',
  'checkout.html',
  'confirmare.html',
  'anulare.html',
  'politica-confidentialitate.html',
  'termeni-conditii.html',
  'admin/index.html',
  'admin/dashboard.html',
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function pngDimensions(relativePath) {
  const buffer = fs.readFileSync(path.join(root, relativePath));
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG', `${relativePath} should be a PNG file`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('site favicon assets', () => {
  it('exports the required favicon files at the expected sizes', () => {
    for (const file of [
      'favicon.ico',
      'assets/favicon-16x16.png',
      'assets/favicon-32x32.png',
      'assets/apple-touch-icon.png',
    ]) {
      assert.ok(exists(file), `${file} should exist`);
    }

    assert.deepEqual(pngDimensions('assets/favicon-16x16.png'), { width: 16, height: 16 });
    assert.deepEqual(pngDimensions('assets/favicon-32x32.png'), { width: 32, height: 32 });
    assert.deepEqual(pngDimensions('assets/apple-touch-icon.png'), { width: 180, height: 180 });
  });

  it('declares the favicon set on every shipped page', () => {
    for (const page of shippedPages) {
      const html = read(page);

      assert.match(
        html,
        /<link rel="icon" type="image\/png" sizes="32x32" href="\/assets\/favicon-32x32\.png">/,
        `${page} should declare the 32x32 favicon`,
      );
      assert.match(
        html,
        /<link rel="icon" type="image\/png" sizes="16x16" href="\/assets\/favicon-16x16\.png">/,
        `${page} should declare the 16x16 favicon`,
      );
      assert.match(
        html,
        /<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/apple-touch-icon\.png">/,
        `${page} should declare the Apple touch icon`,
      );
    }
  });
});
