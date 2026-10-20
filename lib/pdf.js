/**
 * v1.2 2.3b — zero-dependency PDF text extraction for modeling evidence.
 *
 * Supports the classic, non-object-stream PDF layout that small generated
 * papers use:
 * - indirect objects (`N 0 obj … endobj`), page tree `/Catalog → /Pages → /Kids`
 *   (falling back to object-number order when the tree is unreadable),
 * - page `/Contents` streams, single ref or `[ref …]` array,
 * - unfiltered streams and `/FlateDecode` via `node:zlib.inflateSync`,
 * - text-showing operators `Tj`, `TJ` (arrays with kerning numbers), `'`, `"`,
 *   with PDF string escapes (`\n \r \t \b \f \( \) \\ \ddd` and line
 *   continuations) plus `<hex>` strings.
 *
 * Everything is bounded: at most 50 pages and 200KB of extracted text. The
 * module never throws to its callers (returns `{ok:false,error}`) and never
 * writes files. Unsupported features (encrypted PDFs, object streams, other
 * stream filters) fail with a clear error instead of silently returning text.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { inflateSync } from 'node:zlib'

import { LIMITS } from './constants.js'

const PDF_HEADER = '%PDF-'
const STREAM_START = /stream(?:\r\n|\n|\r)/
const FILTER_RE = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/
const PAGE_TYPE_RE = /\/Type\s*\/Page(?!s)\b/
const PAGES_TYPE_RE = /\/Type\s*\/Pages\b/

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateUtf8ToBytes(text, maxBytes) {
  if (maxBytes <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  // Never split a multi-byte UTF-8 sequence.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** Decode one PDF literal-string body (text between the parentheses, escapes intact). */
export function unescapePdfLiteral(body) {
  const source = typeof body === 'string' ? body : ''
  let out = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char !== '\\') {
      out += char
      continue
    }
    index += 1
    if (index >= source.length) break
    const next = source[index]
    switch (next) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '(': out += '('; break
      case ')': out += ')'; break
      case '\\': out += '\\'; break
      case '\r':
        if (source[index + 1] === '\n') index += 1
        break
      case '\n':
        break
      default: {
        if (next >= '0' && next <= '7') {
          let digits = next
          for (let extra = 0; extra < 2; extra += 1) {
            const candidate = source[index + 1]
            if (candidate === undefined || candidate < '0' || candidate > '7') break
            digits += candidate
            index += 1
          }
          out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff)
        } else {
          out += next
        }
      }
    }
  }
  return out
}

/** Parse one `( … )` literal starting at `start`; null when unterminated. */
export function readPdfLiteralString(source, start) {
  if (typeof source !== 'string' || source[start] !== '(') return null
  let depth = 0
  let body = ''
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      body += char
      index += 1
      if (index < source.length) {
        body += source[index]
        if (source[index] === '\r' && source[index + 1] === '\n') {
          body += '\n'
          index += 1
        }
      }
      continue
    }
    if (char === '(') {
      depth += 1
      if (depth > 1) body += char
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { value: unescapePdfLiteral(body), next: index + 1 }
      body += char
      continue
    }
    body += char
  }
  return null
}

function decodeHexString(hex) {
  const digits = String(hex).replace(/[^0-9A-Fa-f]/g, '')
  const bytes = []
  for (let index = 0; index + 1 < digits.length; index += 2) {
    bytes.push(Number.parseInt(digits.slice(index, index + 2), 16))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
    }
    return out
  }
  return Buffer.from(bytes).toString('latin1')
}

function joinTjArray(items) {
  let text = ''
  for (const item of Array.isArray(items) ? items : []) {
    if (item.type === 'string') {
      text += item.value
    } else if (item.type === 'number' && item.value <= -100 && text !== '' && !/\s$/.test(text)) {
      // Large negative kerning between two strings usually separates words.
      text += ' '
    }
  }
  return text
}

function finishText(raw) {
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Extract text from one decoded content stream (exported for tests).
 * @returns {string}
 */
export function extractTextFromContentStream(content) {
  const source = typeof content === 'string' ? content : ''
  let out = ''
  let lastString = ''
  let pendingStrings = []
  let pendingArray = null
  let arrayItems = null
  const newline = () => {
    if (out !== '' && !out.endsWith('\n')) out += '\n'
  }
  const append = (text) => {
    if (typeof text === 'string' && text !== '') out += text
  }
  const resetPending = () => {
    pendingStrings = []
    pendingArray = null
  }
  const handleOperator = (operator) => {
    if (operator === 'Tj') {
      for (const text of pendingStrings) append(text)
    } else if (operator === 'TJ') {
      append(joinTjArray(pendingArray ?? []))
    } else if (operator === 'Td' || operator === 'TD' || operator === 'T*' || operator === 'BT' || operator === 'ET') {
      newline()
    }
    resetPending()
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '%') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (char === '(') {
      const parsed = readPdfLiteralString(source, index)
      if (parsed === null) break
      lastString = parsed.value
      if (arrayItems !== null) arrayItems.push({ type: 'string', value: parsed.value })
      else pendingStrings.push(parsed.value)
      index = parsed.next
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1)
      if (end === -1) break
      const value = decodeHexString(source.slice(index + 1, end))
      lastString = value
      if (arrayItems !== null) arrayItems.push({ type: 'string', value })
      else pendingStrings.push(value)
      index = end + 1
      continue
    }
    if (char === '[') {
      arrayItems = []
      index += 1
      continue
    }
    if (char === ']') {
      pendingArray = arrayItems ?? []
      arrayItems = null
      index += 1
      continue
    }
    if (arrayItems !== null) {
      if (/\s/.test(char)) {
        index += 1
        continue
      }
      if (/[+\-.\d]/.test(char)) {
        const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(index))
        if (match !== null) {
          arrayItems.push({ type: 'number', value: Number(match[0]) })
          index += match[0].length
          continue
        }
      }
      index += 1
      continue
    }
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === "'" || char === '"') {
      // ' / " show the preceding string on a new line (aw/ac operands ignored).
      newline()
      append(lastString)
      resetPending()
      index += 1
      continue
    }
    if (/[A-Za-z*]/.test(char)) {
      let operator = ''
      while (index < source.length && /[A-Za-z*0-9]/.test(source[index])) {
        operator += source[index]
        index += 1
      }
      handleOperator(operator)
      continue
    }
    index += 1
  }
  return finishText(out)
}

function parsePdfObjects(buffer) {
  const latin = buffer.toString('latin1')
  const objects = new Map()
  const objectRe = /(\d+)\s+(\d+)\s+obj\b/g
  let match = objectRe.exec(latin)
  while (match !== null) {
    const number = Number(match[1])
    const start = match.index
    const end = latin.indexOf('endobj', start)
    if (end === -1) return { ok: false, error: 'PDF 对象结构不完整（缺少 endobj）' }
    const segment = latin.slice(start, end)
    const streamMatch = STREAM_START.exec(segment)
    let dictText = segment
    let streamBytes = null
    let nextSearchOffset = end
    if (streamMatch !== null) {
      const dataStart = start + streamMatch.index + streamMatch[0].length
      const endStreamRel = segment.indexOf('endstream', streamMatch.index + streamMatch[0].length)
      if (endStreamRel === -1) return { ok: false, error: 'PDF 对象结构不完整（stream 缺少 endstream）' }
      const dataEnd = start + endStreamRel
      dictText = segment.slice(0, streamMatch.index)
      // Keep the bytes verbatim: a trailing EOL before `endstream` is ignored by
      // the inflate decoder, and stripping it could corrupt binary stream data.
      streamBytes = buffer.subarray(dataStart, Math.max(dataStart, dataEnd))
      // Continue scanning AFTER the stream so binary data can never be parsed as
      // a phantom indirect object.
      nextSearchOffset = dataEnd + 'endstream'.length
    }
    objects.set(number, { number, dict: dictText, stream: streamBytes })
    objectRe.lastIndex = nextSearchOffset
    match = objectRe.exec(latin)
  }
  return { ok: true, objects, latin }
}

function streamFilterNames(dictText) {
  const match = FILTER_RE.exec(dictText)
  if (match === null) return []
  const raw = match[1]
  const names = [...raw.matchAll(/\/([A-Za-z0-9]+)/g)].map((entry) => entry[1])
  return names
}

function decodePdfStream(streamBytes, dictText) {
  const filters = streamFilterNames(dictText)
  if (filters.length === 0) return { ok: true, data: streamBytes }
  if (filters.length > 1) return { ok: false, error: `PDF 内容流过滤器过多（${filters.map((name) => `/${name}`).join(', ')}），暂不支持` }
  const filter = filters[0]
  if (filter !== 'FlateDecode' && filter !== 'Fl') {
    return { ok: false, error: `PDF 内容流使用了不支持的过滤器：/${filter}（仅支持 FlateDecode）` }
  }
  try {
    return { ok: true, data: inflateSync(streamBytes) }
  } catch (error) {
    return { ok: false, error: `PDF FlateDecode 解压失败：${error?.message || error}` }
  }
}

function collectPageNumbers(objects) {
  const catalogs = [...objects.values()].filter((object) => /\/Type\s*\/Catalog\b/.test(object.dict))
  for (const catalog of catalogs) {
    const pagesRef = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(catalog.dict)
    if (pagesRef === null) continue
    const order = []
    const visited = new Set()
    const walk = (number, depth) => {
      if (depth > 64 || visited.has(number) || visited.size > 5000) return
      visited.add(number)
      const node = objects.get(number)
      if (!node) return
      if (PAGE_TYPE_RE.test(node.dict)) {
        order.push(number)
        return
      }
      if (!PAGES_TYPE_RE.test(node.dict)) return
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.dict)
      if (kids === null) return
      const refs = [...kids[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((entry) => Number(entry[1]))
      for (const ref of refs) walk(ref, depth + 1)
    }
    walk(Number(pagesRef[1]), 0)
    if (order.length > 0) return order
  }
  return [...objects.values()]
    .filter((object) => PAGE_TYPE_RE.test(object.dict))
    .map((object) => object.number)
    .sort((left, right) => left - right)
}

function pageContentReferences(pageDict) {
  const arrayMatch = /\/Contents\s*\[([^\]]*)\]/.exec(pageDict)
  if (arrayMatch !== null) {
    return [...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((entry) => Number(entry[1]))
  }
  const singleMatch = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageDict)
  return singleMatch === null ? [] : [Number(singleMatch[1])]
}

function pageText(pageNumber, objects) {
  const page = objects.get(pageNumber)
  if (!page) return { ok: true, text: '' }
  const chunks = []
  for (const reference of pageContentReferences(page.dict)) {
    const content = objects.get(reference)
    if (!content || content.stream === null || content.stream === undefined) continue
    const decoded = decodePdfStream(content.stream, content.dict)
    if (!decoded.ok) return { ok: false, error: decoded.error }
    chunks.push(decoded.data.toString('latin1'))
  }
  return { ok: true, text: extractTextFromContentStream(chunks.join('\n')) }
}

function resolveLimits(options) {
  const source = isPlainObject(options) ? options : {}
  const maxPages = Number.isInteger(source.maxPages) && source.maxPages > 0
    ? Math.min(LIMITS.pdfMaxPages, source.maxPages)
    : LIMITS.pdfMaxPages
  const maxTextBytes = Number.isInteger(source.maxTextBytes) && source.maxTextBytes > 0
    ? Math.min(LIMITS.pdfMaxTextBytes, source.maxTextBytes)
    : LIMITS.pdfMaxTextBytes
  return { maxPages, maxTextBytes }
}

/**
 * Extract text from PDF bytes.
 * @param {Buffer|Uint8Array} input PDF bytes
 * @param {{maxPages?: number, maxTextBytes?: number}} [options]
 * @returns {{ok: true, pageCount: number, pages: string[], text: string, truncated: boolean, sha256: string}
 *          |{ok: false, error: string}}
 */
export function extractPdfTextFromBuffer(input, options = {}) {
  let buffer = null
  if (Buffer.isBuffer(input)) buffer = input
  else if (input instanceof Uint8Array) buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buffer === null || buffer.length === 0) return { ok: false, error: 'PDF 文件为空或无法读取' }
  if (!buffer.toString('latin1', 0, 1024).includes(PDF_HEADER)) {
    return { ok: false, error: '不是有效的 PDF 文件（缺少 %PDF- 文件头）' }
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const { maxPages, maxTextBytes } = resolveLimits(options)
  const parsed = parsePdfObjects(buffer)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(parsed.latin)) {
    return { ok: false, error: '不支持加密的 PDF 文件' }
  }
  const pageNumbers = collectPageNumbers(parsed.objects)
  if (pageNumbers.length === 0) {
    return { ok: false, error: '未找到可解析的 PDF 页面对象（可能使用了不支持的压缩对象流或文件已损坏）' }
  }
  const pages = []
  let usedBytes = 0
  let truncated = pageNumbers.length > maxPages
  for (let index = 0; index < Math.min(pageNumbers.length, maxPages); index += 1) {
    const extracted = pageText(pageNumbers[index], parsed.objects)
    if (!extracted.ok) return { ok: false, error: extracted.error }
    let text = extracted.text
    const room = maxTextBytes - usedBytes
    if (room <= 0) {
      pages.push('')
      truncated = true
      continue
    }
    const byteLength = Buffer.byteLength(text, 'utf8')
    if (byteLength > room) {
      text = truncateUtf8ToBytes(text, room)
      truncated = true
    }
    pages.push(text)
    usedBytes += Buffer.byteLength(text, 'utf8')
  }
  return {
    ok: true,
    pageCount: pages.length,
    pages,
    text: pages.filter((text) => text !== '').join('\n\n'),
    truncated,
    sha256,
  }
}

/**
 * Read + extract one PDF file. Never throws.
 * @param {string} filePath absolute/relative path on disk
 * @param {{fsImpl?: object, maxPages?: number, maxTextBytes?: number}} [options]
 */
export async function extractPdfText(filePath, options = {}) {
  const { fsImpl = fs } = isPlainObject(options) ? options : {}
  if (typeof filePath !== 'string' || filePath.trim() === '') return { ok: false, error: '缺少 PDF 文件路径' }
  let buffer = null
  try {
    buffer = await fsImpl.readFile(filePath)
  } catch (error) {
    return { ok: false, error: `PDF 文件读取失败：${error?.code === 'ENOENT' ? '文件不存在' : (error?.message || error)}` }
  }
  return extractPdfTextFromBuffer(buffer, options)
}
