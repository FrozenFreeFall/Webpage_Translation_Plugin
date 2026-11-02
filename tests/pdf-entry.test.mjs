import test from 'node:test';
import assert from 'node:assert/strict';

const entry = await import('../src/pdf-entry.js').catch(() => ({}));

test('PDF source URLs preserve signed queries and pass the page separately', () => {
  assert.equal(typeof entry.pdfReaderURL, 'function');
  const url = new URL(entry.pdfReaderURL('chrome-extension://test/pdf.html', 'https://books.test/download?id=1&token=a%2Fb#page=12'));
  assert.equal(url.searchParams.get('file'), 'https://books.test/download?id=1&token=a%2Fb');
  assert.equal(url.searchParams.get('page'), '12');
  assert.equal(entry.isPdfURL('https://books.test/BOOK.PDF?download=1#page=8'), true);
  assert.equal(entry.isPdfURL('https://books.test/?next=foo.pdf'), false);
});

test('PDF sources reject executable, embedded credential and extension URLs', () => {
  assert.equal(typeof entry.normalizePdfSource, 'function');
  for (const value of ['javascript:alert(1)', 'data:application/pdf,abc', 'https://user:secret@books.test/a.pdf', 'chrome-extension://other/pdf.html', 'file://server/private/a.pdf', 'not a URL']) {
    assert.throws(() => entry.normalizePdfSource(value));
  }
  assert.equal(entry.normalizePdfSource('file:///C:/Books/a%20b.pdf#page=2'), 'file:///C:/Books/a%20b.pdf');
});

test('only the exact reader page is recognized, allowing query and fragment', () => {
  assert.equal(typeof entry.isPdfReaderURL, 'function');
  const expected = 'chrome-extension://test/pdf.html';
  assert.equal(entry.isPdfReaderURL(`${expected}?file=https%3A%2F%2Fbooks.test%2Fa.pdf#page=2`, expected), true);
  for (const value of ['chrome-extension://other/pdf.html', 'https://test/pdf.html', `${expected}/more`, `${expected}.evil`, 'chrome-extension://test/folder/pdf.html']) assert.equal(entry.isPdfReaderURL(value, expected), false);
});
