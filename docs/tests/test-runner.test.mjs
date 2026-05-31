import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('EcoVila test runner contract', () => {
  it('defines dependency-free root scripts for the full test suite', () => {
    const manifest = JSON.parse(read('package.json'));

    assert.equal(manifest.scripts.test, 'npm run test:node && npm run test:deno');
    assert.equal(manifest.scripts['test:node'], "node --test 'docs/tests/**/*.test.mjs'");
    assert.equal(
      manifest.scripts['test:deno'],
      'cd docs/supabase/functions && deno task test',
    );
    assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
    assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
  });

  it('documents npm test as the canonical one-command runner', () => {
    const readme = read('docs/README.md');
    const decisions = read('docs/decisions.md');

    assert.match(readme, /npm test[\s\S]*171 Node \+ 32 Deno/i);
    assert.match(decisions, /ADR-009[\s\S]*minimal root `package\.json`/);
  });
});
