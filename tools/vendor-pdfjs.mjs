// Reproduce the checked-in browser runtime with `npm run vendor:pdfjs`.
// No npm install, lifecycle scripts, transpiler, CDN, or build is needed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '6.5.438';
const INTEGRITY = 'sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==';
const TARBALL = `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz`;
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'vendor/pdfjs');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (packageJson.devDependencies['pdfjs-dist'] !== VERSION) throw new Error('Update the PDF.js pin and vendor metadata together.');

const response = await fetch(TARBALL);
if (!response.ok) throw new Error(`PDF.js download failed: HTTP ${response.status}`);
const compressed = Buffer.from(await response.arrayBuffer());
const actual = `sha512-${createHash('sha512').update(compressed).digest('base64')}`;
if (actual !== INTEGRITY) throw new Error('PDF.js npm tarball integrity mismatch. No files were written.');
const tar = gunzipSync(compressed);
const files = [];
let offset = 0;
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
  const prefix = field(345, 500);
  const name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
  const size = parseInt(field(124, 136).trim(), 8) || 0;
  const type = field(156, 157);
  offset += 512;
  if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) throw new Error('Invalid PDF.js tar entry size.');
  let output;
  if (name === 'package/legacy/build/pdf.min.mjs') output = 'pdf.mjs';
  else if (name === 'package/legacy/build/pdf.worker.min.mjs') output = 'pdf.worker.mjs';
  else if (name === 'package/LICENSE') output = 'LICENSE';
  else if (/^package\/(?:cmaps|standard_fonts|wasm)\//.test(name)) output = name.slice('package/'.length);
  if (output && (type === '' || type === '0')) {
    const target = resolve(destination, output);
    if (!target.startsWith(destination + sep)) throw new Error('Invalid PDF.js tar path.');
    files.push({ output, data: tar.subarray(offset, offset + size) });
  }
  offset += Math.ceil(size / 512) * 512;
}
for (const required of ['pdf.mjs', 'pdf.worker.mjs', 'LICENSE', 'cmaps/Adobe-Japan1-UCS2.bcmap',
  'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm']) {
  if (!files.some(file => file.output === required)) throw new Error(`Missing runtime asset in PDF.js tarball: ${required}`);
}
// Verification completes before writing. The script never follows links or
// recursively deletes a destination, and writes only allowlisted archive files.
for (const { output, data } of files) {
  const target = resolve(destination, output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
const metadata = {
  package: 'pdfjs-dist', version: VERSION, build: 'legacy/minified', license: 'Apache-2.0',
  source: TARBALL, integrity: INTEGRITY,
  upstream: `https://github.com/mozilla/pdf.js/releases/tag/v${VERSION}`,
  files: Object.fromEntries(files.sort((a, b) => a.output.localeCompare(b.output, 'en'))
    .map(file => [file.output, createHash('sha256').update(file.data).digest('hex')]))
};
await writeFile(resolve(destination, 'VERSION.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Vendored PDF.js ${VERSION} legacy: ${files.length} files, ${files.reduce((sum, file) => sum + file.data.length, 0)} bytes.`);
