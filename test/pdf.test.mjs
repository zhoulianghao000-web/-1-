/**
 * v1.2 2.3b — zero-dependency PDF text extraction tests.
 *
 * Fixtures are handcrafted minimal PDFs (no external tools): catalog/pages/page/
 * content objects, uncompressed and `/FlateDecode` streams, multi-page tree
 * order, PDF string escapes, Tj/TJ/'/" operators, hex strings and malformed
 * inputs. No file is ever produced outside the test temp dir.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import {
  extractPdfText,
  extractPdfTextFromBuffer,
  extractTextFromContentStream,
  readPdfLiteralString,
  unescapePdfLiteral,
} from '../lib/pdf.js'

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rtc-pdf-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * Build a minimal valid PDF.
 * @param {{pages: string[], flate?: boolean}} options page content streams
 */
function makePdf(options = {}) {
  const { pages = ['BT /F1 24 Tf 72 720 Td (Hello World) Tj ET'], flate = false } = options
  const objects = []
  const kids = []
  let nextNumber = 3
  for (const content of pages) {
    const pageNumber = nextNumber
    const contentNumber = nextNumber + 1
    nextNumber += 2
    kids.push(`${pageNumber} 0 R`)
    const raw = Buffer.from(content, 'latin1')
    const stream = flate ? deflateSync(raw) : raw
    objects.push(`${pageNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R >>\nendobj\n`)
    const filter = flate ? ' /Filter /FlateDecode' : ''
    objects.push(`${contentNumber} 0 obj\n<< /Length ${stream.length}${filter} >>\nstream\n${stream.toString('latin1')}\nendstream\nendobj\n`)
  }
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>\nendobj\n${objects.join('')}trailer\n<< /Root 1 0 R /Size ${nextNumber} >>\nstartxref\n0\n%%EOF\n`, 'latin1')
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------------------
// string literals
// ---------------------------------------------------------------------------

test('unescapePdfLiteral handles PDF escapes and octal codes', () => {
  assert.equal(unescapePdfLiteral('plain text'), 'plain text')
  assert.equal(unescapePdfLiteral('line1\\nline2'), 'line1\nline2')
  assert.equal(unescapePdfLiteral('a\\tb\\rc'), 'a\tb\rc')
  assert.equal(unescapePdfLiteral('paren\\(x\\) done'), 'paren(x) done')
  assert.equal(unescapePdfLiteral('back\\\\slash'), 'back\\slash')
  assert.equal(unescapePdfLiteral('\\101\\102C'), 'ABC')
  assert.equal(unescapePdfLiteral('soft\\\nbreak'), 'softbreak')
  assert.equal(unescapePdfLiteral(''), '')
  assert.equal(unescapePdfLiteral(42), '')
})

test('readPdfLiteralString handles nested parentheses and stops at the matching close', () => {
  const parsed = readPdfLiteralString('(hello (nested) world) Tj', 0)
  assert.equal(parsed.value, 'hello (nested) world')
  assert.equal(' Tj'.trim(), 'Tj')
  assert.equal(readPdfLiteralString('(unterminated', 0), null)
  assert.equal(readPdfLiteralString('no-string', 0), null)
})

// ---------------------------------------------------------------------------
// content-stream operators
// ---------------------------------------------------------------------------

test('extractTextFromContentStream handles Tj, TJ kerning, quotes and line moves', () => {
  assert.equal(extractTextFromContentStream('BT /F1 12 Tf (Hello) Tj ET'), 'Hello')
  assert.equal(extractTextFromContentStream('[(Hello) -150 (World)] TJ'), 'Hello World')
  assert.equal(extractTextFromContentStream('[(Hel) (lo)] TJ'), 'Hello')
  assert.equal(extractTextFromContentStream("(Line one) '\n(Line two) '"), 'Line one\nLine two')
  assert.equal(extractTextFromContentStream('1 1 1 rg (Quoted) "'), 'Quoted')
  assert.equal(extractTextFromContentStream('BT (First) Tj ET BT (Second) Tj ET'), 'First\nSecond')
  // Escaped and hex strings.
  assert.equal(extractTextFromContentStream('(\\050x\\051) Tj'), '(x)')
  assert.equal(extractTextFromContentStream('<48656C6C6F> Tj'), 'Hello')
  assert.equal(extractTextFromContentStream('<FEFF00480069> Tj'), 'Hi')
  // Comments are ignored.
  assert.equal(extractTextFromContentStream('% comment (not text) Tj\n(Real) Tj'), 'Real')
})

// ---------------------------------------------------------------------------
// full PDF extraction
// ---------------------------------------------------------------------------

test('extractPdfTextFromBuffer reads a plain single-page PDF', () => {
  const buffer = makePdf()
  const result = extractPdfTextFromBuffer(buffer)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.pageCount, 1)
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0], 'Hello World')
  assert.equal(result.text, 'Hello World')
  assert.equal(result.truncated, false)
  assert.equal(result.sha256, sha256(buffer))
})

test('extractPdfTextFromBuffer decodes FlateDecode content streams', () => {
  const buffer = makePdf({
    flate: true,
    pages: [
      'BT /F1 12 Tf 72 720 Td (Compressed page one) Tj ET',
      'BT /F1 12 Tf 72 720 Td (Compressed page two) Tj ET',
    ],
  })
  const result = extractPdfTextFromBuffer(buffer)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.pageCount, 2)
  assert.deepEqual(result.pages, ['Compressed page one', 'Compressed page two'])
})

test('extractPdfTextFromBuffer follows the page-tree order, not object numbers', () => {
  const first = Buffer.from('(FIRSTPAGE) Tj', 'latin1')
  const second = Buffer.from('(SECONDPAGE) Tj', 'latin1')
  const pdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [5 0 R 3 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${second.length} >>
stream
${second.toString('latin1')}
endstream
endobj
5 0 obj
<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>
endobj
6 0 obj
<< /Length ${first.length} >>
stream
${first.toString('latin1')}
endstream
endobj
%%EOF
`, 'latin1')
  const result = extractPdfTextFromBuffer(pdf)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.pages, ['FIRSTPAGE', 'SECONDPAGE'])
})

test('extractPdfTextFromBuffer falls back to object-number order without a catalog tree', () => {
  const pdf = Buffer.from(`%PDF-1.4
3 0 obj
<< /Type /Page /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 14 >>
stream
(Second page) Tj
endstream
endobj
5 0 obj
<< /Type /Page /Contents 6 0 R >>
endobj
6 0 obj
<< /Length 13 >>
stream
(First page) Tj
endstream
endobj
%%EOF
`, 'latin1')
  const result = extractPdfTextFromBuffer(pdf)
  assert.equal(result.ok, true, result.error)
  // Pages were declared without /Pages: sorted by object number (3 before 5).
  assert.deepEqual(result.pages, ['Second page', 'First page'])
})

test('extractPdfTextFromBuffer enforces the page and text budgets', () => {
  const pages = Array.from({ length: 60 }, (_unused, index) => `(Page ${index + 1} content) Tj`)
  const many = extractPdfTextFromBuffer(makePdf({ pages }))
  assert.equal(many.ok, true, many.error)
  assert.equal(many.pageCount, 50)
  assert.equal(many.truncated, true)

  const long = extractPdfTextFromBuffer(makePdf({ pages: [`(${'x'.repeat(5000)}) Tj`] }), { maxTextBytes: 100 })
  assert.equal(long.ok, true, long.error)
  assert.equal(long.truncated, true)
  assert.equal(Buffer.byteLength(long.pages[0], 'utf8') <= 100, true)
})

test('extractPdfTextFromBuffer rejects malformed / unsupported PDFs with clear errors', () => {
  assert.match(extractPdfTextFromBuffer(Buffer.alloc(0)).error, /空/)
  assert.match(extractPdfTextFromBuffer(Buffer.from('not a pdf')).error, /%PDF-/)
  const noPages = extractPdfTextFromBuffer(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1'))
  assert.equal(noPages.ok, false)
  assert.match(noPages.error, /页面对象/)

  const unsupportedFilter = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 3 /Filter /DCTDecode >>
stream
abc
endstream
endobj
%%EOF
`, 'latin1')
  const filtered = extractPdfTextFromBuffer(unsupportedFilter)
  assert.equal(filtered.ok, false)
  assert.match(filtered.error, /不支持的过滤器/)

  // Missing endstream.
  const broken = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 3 >>\nstream\nabc\nendobj\n', 'latin1')
  assert.match(extractPdfTextFromBuffer(broken).error, /endstream/)

  // Encrypted PDFs are explicitly unsupported.
  const encrypted = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] >>\nendobj\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n', 'latin1')
  assert.equal(extractPdfTextFromBuffer(encrypted).ok, false)
})

test('extractPdfText reads from disk and reports file errors', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'paper.pdf')
  const buffer = makePdf({ pages: ['(Disk page) Tj'] })
  await writeFile(file, buffer)
  const result = await extractPdfText(file)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.pages[0], 'Disk page')
  assert.equal(result.sha256, sha256(buffer))

  const missing = await extractPdfText(path.join(dir, 'missing.pdf'))
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
  const noPath = await extractPdfText('')
  assert.match(noPath.error, /路径/)
})
