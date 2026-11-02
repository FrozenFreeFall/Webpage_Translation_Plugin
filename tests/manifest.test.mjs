import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('unpacked manifest resolves every runtime entry without a build step', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const files = ['pdf.html', manifest.background.service_worker, manifest.options_page, manifest.action.default_popup, ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css])];
  for (const file of files) {
    assert.ok(!path.isAbsolute(file) && !file.includes('..'));
    await access(path.join(root, file));
  }
  for (const file of ['pdf.html', manifest.options_page, manifest.action.default_popup]) {
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

test('PDF runtime ships its pinned worker, fonts and codecs locally with matching integrity metadata', async () => {
  const { createHash } = await import('node:crypto');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(path.join(root, 'vendor/pdfjs/VERSION.json'), 'utf8'));
  assert.equal(metadata.version, pkg.devDependencies['pdfjs-dist']);
  for (const required of ['pdf.mjs', 'pdf.worker.mjs', 'LICENSE', 'cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) assert.ok(Object.hasOwn(metadata.files, required));
  for (const [name, expected] of Object.entries(metadata.files)) {
    assert.ok(!path.isAbsolute(name) && !name.includes('..'));
    const data = await readFile(path.join(root, 'vendor/pdfjs', name));
    assert.equal(createHash('sha256').update(data).digest('hex'), expected, name);
  }
});
