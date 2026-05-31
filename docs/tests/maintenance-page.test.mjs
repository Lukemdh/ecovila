import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('temporary homepage holding page', () => {
  it('shows the maintenance message on the public homepage', () => {
    const html = read('index.html');

    assert.match(html, /Lucrăm la îmbunătățirea site-ului/);
    assert.match(html, /href="tel:\+37360120220"/);
    assert.match(html, /Pentru rezervări: 060120220/);
    assert.doesNotMatch(html, /href="rezervari\.html"/);
  });

  it('keeps the full landing page available at a direct URL', () => {
    const html = read('site.html');

    assert.match(html, /id="hero"/);
    assert.match(html, /href="rezervari\.html"/);
  });
});
