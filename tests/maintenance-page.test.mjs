import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('approved launch homepage', () => {
  it('serves the full Romanian landing page at the root', () => {
    const html = read('index.html');

    assert.doesNotMatch(html, /Lucrăm la îmbunătățirea site-ului|În curând/);
    assert.match(html, /id="hero"/);
    assert.match(html, /href="\/rezervari\.html"/);
    assert.match(html, /Un refugiu all-inclusive în inima pădurii/i);
    assert.doesNotMatch(html, /Ofertă 2026|1550 lei|1800 lei/i);
  });

  it('keeps the transition source page redirectable instead of shipping it as production root', () => {
    const html = read('site.html');
    const htaccess = read('.htaccess');

    assert.match(html, /id="hero"/);
    assert.match(html, /href="rezervari\.html"/);
    assert.match(htaccess, /^RewriteRule \^site\\\.html\$ \/ \[R=301,L\]$/m);
  });
});
