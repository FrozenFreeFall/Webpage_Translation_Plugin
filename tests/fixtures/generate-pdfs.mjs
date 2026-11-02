// Reproducible, dependency-free fixtures. All prose, code and graphics are original.
import { writeFile } from 'node:fs/promises';

const literal = text => `(${text.replace(/[\\()]/g, character => `\\${character}`)})`;
const line = (text, x, y, font = 'F1', size = 12) => `BT /${font} ${size} Tf ${x} ${y} Td ${literal(text)} Tj ET`;
const stream = (data, dictionary = '') => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'ascii');
  return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${dictionary} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
};
function pdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n'));
  }
  const xref = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

const pageOne = [
  line('A small guide to reliable PDF reading.', 54, 726, 'F1', 20),
  line('This original document explains how careful readers compare', 54, 674),
  line('a source page with a translation while keeping useful context.', 54, 656),
  line('A translation starts only after the reader asks for the current', 54, 610),
  line('page. The chart below is part of the original PDF artwork.', 54, 592),
  line('function privateExample(value) {', 54, 510, 'F2', 11),
  line('  return value * 2;', 54, 494, 'F2', 11),
  line('}', 54, 478, 'F2', 11),
  'q 0.94 0.93 0.99 rg 54 280 500 130 re f',
  '0.38 0.31 0.75 RG 2 w 84 302 m 84 382 l 518 382 m 84 382 l S',
  '0.40 0.34 0.82 RG 4 w 84 318 m 190 330 l 296 344 l 402 358 l 518 370 l S Q',
].join('\n');
const pageTwo = [
  line('Second page: lifecycle and cancellation.', 54, 726, 'F1', 20),
  line('Page two has its own sentences and its own translation state.', 54, 674),
  line('Changing pages must discard late answers for the previous page.', 54, 656),
  line('The source PDF remains available when the reading mode changes.', 54, 610),
  line('Choosing a new file also starts a fresh document session.', 54, 592),
].join('\n');
const resources = '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >>';
await writeFile(new URL('./sample.pdf', import.meta.url), pdf([
  '<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>',
  '<< /Type /Pages /Kids [5 0 R 7 0 R] /Count 2 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources} /Contents 6 0 R >>`,
  stream(pageOne),
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources} /Contents 8 0 R >>`,
  stream(pageTwo),
  '<< /Type /Outlines /First 10 0 R /Last 11 0 R /Count 2 >>',
  '<< /Title (Reliable reading) /Parent 9 0 R /Dest [5 0 R /Fit] /Next 11 0 R >>',
  '<< /Title (Lifecycle) /Parent 9 0 R /Dest [7 0 R /Fit] /Prev 10 0 R >>',
]));

// Image-only PDF: deliberately no text operators or font resources, so OCR would
// be needed to turn even the simple raster artwork into readable text.
const pixels = Buffer.from([255, 255, 255, 115, 97, 204, 115, 97, 204, 255, 255, 255]);
await writeFile(new URL('./scanned.pdf', import.meta.url), pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>',
  stream('q 450 0 0 180 81 306 cm /Scan Do Q'),
  stream(pixels, '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
]));
await writeFile(new URL('./invalid.pdf', import.meta.url), 'This is an invalid PDF fixture.\n');
