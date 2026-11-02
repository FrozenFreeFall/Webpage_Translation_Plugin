import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('unpacked manifest resolves every runtime entry without a build step', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const files = [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup, ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css])];
  for (const file of files) {
    assert.ok(!path.isAbsolute(file) && !file.includes('..'));
    await access(path.join(root, file));
  }
  for (const file of [manifest.options_page, manifest.action.default_popup]) {
    const html = await readFile(path.join(root, file), 'utf8');
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    for (const asset of assets) {
      assert.doesNotMatch(asset, /^(https?:)?\/\//);
      await access(path.join(root, asset));
    }
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  }
  assert.ok(!manifest.permissions.some((permission) => ['cookies', 'history', 'debugger', 'downloads'].includes(permission)));
});
