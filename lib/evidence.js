/**
 * Evidence framework (v1.2 2.1).
 *
 * Every review round is backed by exactly N (default 4) "evidence cards". A
 * card is either:
 *
 * - `screenshot`: one static viewport PNG (rendered by `lib/shots.js`, the
 *   same battle-tested `--screenshot` path the pre-v1.2 tool used), or
 * - `interaction`: a scripted playthrough (`goto` / `wait` / `click` / `key` /
 *   `screenshot` steps) rendered by the zero-dependency CDP runner
 *   (`lib/cdp.js`), with console / network / performance metadata.
 *
 * Each card records one or more image artifacts. The FIRST image artifact of a
 * card is its representative and keeps the legacy `r<N>-s<K>-<slug>.png`
 * filename, so `round.shots` (4 rows), the stop gate (`shots===4`), the
 * `/adversarial-review/shot` route and the existing Web gallery keep working
 * unchanged. Extra frames are stored as `r<N>-s<K>-x<idx>-<slug>.png`.
 *
 * Backwards compatibility: a legacy `shots` argument is mapped to N screenshot
 * cards, so an old caller gets exactly the same files/behaviour as before.
 *
 * Artifacts are always written below `<stateDir>/shots/<cycleId>` — never into
 * the reviewed target. `cleanRoundShots` removes only `r<N>-*` leftovers of the
 * round being re-rendered.
 *
 * All helpers are pure or accept injected fs/renderer/runner functions; the
 * module never launches a browser by itself unless the caller asks it to.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runInteractionCard as defaultRunInteractionCard, resolveKeyDefinition } from './cdp.js'
import {
  EVIDENCE_ACTIONS,
  EVIDENCE_DEFAULT_VIEWPORT,
  EVIDENCE_KINDS,
  LIMITS,
  PDF_TEXT_DEFAULT_VIEWPORT,
} from './constants.js'
import { extractPdfText } from './pdf.js'
import {
  buildShotFilename,
  cleanRoundShots,
  isLoopbackHostname,
  normalizeAllowedOrigins,
  normalizeDimension,
  pathToFileUrl,
  pngDimensions,
  renderShots as defaultRenderShots,
  resolveChromePath,
  slugifyName,
  verifyShotFile,
} from './shots.js'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,80}$/
const IMAGE_ARTIFACT = /^r\d{1,4}-s\d{1,4}-(?:x\d{1,3}-)?[A-Za-z0-9._-]{1,80}\.png$/
const ANY_ARTIFACT = /^r\d{1,4}-s\d{1,4}-(?:x\d{1,3}-)?[A-Za-z0-9._-]{1,80}\.(?:png|json|log|txt)$/i
const MIN_PNG_BYTES = 1024
const DEFAULT_WIDTH = EVIDENCE_DEFAULT_VIEWPORT.width
const DEFAULT_HEIGHT = EVIDENCE_DEFAULT_VIEWPORT.height
const PDF_DEFAULT_WIDTH = PDF_TEXT_DEFAULT_VIEWPORT.width
const PDF_DEFAULT_HEIGHT = PDF_TEXT_DEFAULT_VIEWPORT.height
const MAX_PDF_PAGE_NUMBER = 100_000

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function stringArray(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (out.length >= maxItems) break
    if (typeof item !== 'string' || item === '') continue
    out.push(truncateText(item, maxChars))
  }
  return out
}

function isImageArtifact(artifact) {
  return isPlainObject(artifact) && typeof artifact.file === 'string' && artifact.file.toLowerCase().endsWith('.png')
}

/** First image artifact of a card = its representative (legacy `round.shots` row). */
export function representativeArtifact(card) {
  if (!isPlainObject(card) || !Array.isArray(card.artifacts)) return null
  return card.artifacts.find((artifact) => isImageArtifact(artifact)) ?? null
}

/** Empty console/network/perf metadata block used by static screenshot cards. */
export function emptyEvidenceMeta(options = {}) {
  const { url = '', page = '' } = isPlainObject(options) ? options : {}
  return {
    url: typeof url === 'string' ? url : '',
    page: typeof page === 'string' ? page : '',
    console: { events: [], errors: 0, truncated: false },
    network: { requests: 0, failures: 0, truncated: false, failureSamples: [] },
    perf: { metrics: {}, fps: null },
    steps: [],
  }
}

/**
 * Resolve one navigation resource: exactly one of `path` (relative to target,
 * resolved inside it) or `url` (http(s), loopback or `allowedOrigins`).
 * @returns {{ok: true, path: string|null, url: string, page: string, warnings: string[]}|{ok: false, error: string}}
 */
export function resolveEvidenceResource(rawValue, options = {}) {
  const { targetDir = '', allowedOrigins = [], label = '证据卡' } = isPlainObject(options) ? options : {}
  const source = isPlainObject(rawValue) ? rawValue : {}
  const rawPath = typeof source.path === 'string' ? source.path.trim() : ''
  const rawUrl = typeof source.url === 'string' ? source.url.trim() : ''
  if (rawPath !== '' && rawUrl !== '') return { ok: false, error: `${label} 不能同时提供 path 和 url（二者互斥）` }
  if (rawPath === '' && rawUrl === '') return { ok: false, error: `${label} 必须提供 path 或 url 之一` }
  const warnings = []
  if (rawUrl !== '') {
    let parsed = null
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, error: `${label} 的 url 不是合法 URL：${rawUrl}` }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `${label} 的 url 只允许 http/https（收到 ${parsed.protocol}）：${rawUrl}` }
    }
    const allowed = normalizeAllowedOrigins(allowedOrigins)
    if (!isLoopbackHostname(parsed.hostname) && !allowed.has(parsed.origin)) {
      return {
        ok: false,
        error: `${label} 的 url 主机不在白名单：${parsed.origin}（只允许 127.0.0.1 / ::1 / localhost 或配置项 allowedOrigins 中显式列出的 origin）`,
      }
    }
    return { ok: true, path: null, url: parsed.href, page: parsed.href, warnings }
  }
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return { ok: false, error: `缺少 target 目录，无法解析 ${label} 的 path` }
  }
  const resolvedTarget = path.resolve(targetDir)
  const resolvedPath = path.resolve(resolvedTarget, rawPath)
  const relative = path.relative(resolvedTarget, resolvedPath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `${label} 的 path 必须位于 target 目录内：${rawPath}` }
  }
  return {
    ok: true,
    path: resolvedPath,
    url: pathToFileUrl(resolvedPath),
    page: relative.split(path.sep).join('/'),
    warnings,
  }
}

function normalizeSteps(rawSteps, cardLabel, options = {}) {
  const { targetDir = '', allowedOrigins = [], cardUrl = '', cardPage = '' } = isPlainObject(options) ? options : {}
  const warnings = []
  if (rawSteps === undefined || rawSteps === null) return { ok: true, steps: [], warnings }
  if (!Array.isArray(rawSteps)) return { ok: false, error: `${cardLabel} 的 steps 必须是数组` }
  if (rawSteps.length > LIMITS.maxEvidenceStepsPerCard) {
    return { ok: false, error: `${cardLabel} 的 steps 最多 ${LIMITS.maxEvidenceStepsPerCard} 步（收到 ${rawSteps.length} 步）` }
  }
  const steps = []
  for (let index = 0; index < rawSteps.length; index += 1) {
    const raw = rawSteps[index]
    const label = `${cardLabel} 的第 ${index + 1} 个步骤`
    if (!isPlainObject(raw)) return { ok: false, error: `${label} 必须是对象` }
    const action = typeof raw.action === 'string' ? raw.action.trim() : ''
    if (!EVIDENCE_ACTIONS.includes(action)) {
      return { ok: false, error: `${label} 的 action 不合法：${action || '（缺失）'}（只支持 ${EVIDENCE_ACTIONS.join(' / ')}）` }
    }
    if (action === 'goto') {
      const hasPath = typeof raw.path === 'string' && raw.path.trim() !== ''
      const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== ''
      if (hasPath && hasUrl) return { ok: false, error: `${label} 不能同时提供 path 和 url（二者互斥）` }
      if (!hasPath && !hasUrl) {
        steps.push({ action, url: cardUrl, page: cardPage })
        continue
      }
      const resource = resolveEvidenceResource(raw, { targetDir, allowedOrigins, label })
      if (!resource.ok) return { ok: false, error: resource.error }
      warnings.push(...resource.warnings)
      steps.push({ action, url: resource.url, page: resource.page, path: resource.path })
      continue
    }
    if (action === 'wait') {
      const ms = raw.ms === undefined || raw.ms === null ? 300 : Number(raw.ms)
      if (!Number.isInteger(ms) || ms < 0 || ms > 10_000) {
        return { ok: false, error: `${label} 需要 ms（0–10000 的整数，单位毫秒）` }
      }
      steps.push({ action, ms })
      continue
    }
    if (action === 'click') {
      const selector = typeof raw.selector === 'string' ? raw.selector.trim() : ''
      if (selector === '') return { ok: false, error: `${label} 需要 selector（CSS 选择器字符串）` }
      if (selector.length > 300) return { ok: false, error: `${label} 的 selector 过长（超过 300 字符）` }
      steps.push({ action, selector })
      continue
    }
    if (action === 'key') {
      const definition = resolveKeyDefinition(raw.key)
      if (definition === null) {
        return { ok: false, error: `${label} 需要合法的 key（Space/Enter/Escape/Tab/方向键/单个字母或数字）` }
      }
      steps.push({ action, key: String(raw.key).trim() })
      continue
    }
    // screenshot
    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? truncateText(raw.name.trim(), 64) : `step-${index + 1}`
    steps.push({ action, name })
  }
  return { ok: true, steps, warnings }
}

function normalizeCollect(rawCollect) {
  const source = isPlainObject(rawCollect) ? rawCollect : {}
  return {
    console: source.console !== false,
    network: source.network !== false,
    perf: source.perf !== false,
  }
}

/**
 * Validate and normalize the tool's `evidence` argument.
 *
 * @param {*} rawCards caller-supplied array
 * @param {object} options `{targetDir, requiredEvidence, allowedOrigins}`
 * @returns {{ok: true, cards: object[], warnings: string[]}|{ok: false, error: string}}
 */
export function normalizeEvidenceCards(rawCards, options = {}) {
  const {
    targetDir = '',
    requiredEvidence = 4,
    allowedOrigins = [],
    maxCards = LIMITS.maxEvidenceCards,
    maxArtifacts = LIMITS.maxEvidenceArtifacts,
  } = isPlainObject(options) ? options : {}
  if (!Array.isArray(rawCards)) return { ok: false, error: 'evidence 必须是数组（恰好 4 个证据卡）' }
  if (rawCards.length !== requiredEvidence) {
    return { ok: false, error: `证据卡必须恰好 ${requiredEvidence} 个（本次收到 ${rawCards.length} 个）。与 shots 二选一：提供 evidence 时不接受旧 shots 数组。` }
  }
  if (rawCards.length > maxCards) return { ok: false, error: `证据卡最多 ${maxCards} 个` }
  const warnings = []
  const cards = []
  for (let index = 0; index < rawCards.length; index += 1) {
    const raw = rawCards[index]
    const label = `第 ${index + 1} 个证据卡`
    if (!isPlainObject(raw)) return { ok: false, error: `${label} 必须是对象` }
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
    if (!EVIDENCE_KINDS.includes(kind)) {
      return { ok: false, error: `${label} 的 kind 不合法：${kind || '（缺失）'}（只支持 ${EVIDENCE_KINDS.join(' / ')}）` }
    }
    const localFileKind = kind === 'image' || kind === 'pdf-text'
    const rawPath = typeof raw.path === 'string' ? raw.path.trim() : ''
    const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (localFileKind && rawUrl !== '') {
      return { ok: false, error: `${label} 是 ${kind} 卡：只支持 target 内的 path（项目本地文件），不支持 url` }
    }
    if (localFileKind && rawPath === '') {
      return { ok: false, error: `${label} 是 ${kind} 卡：必须提供 target 内的 path` }
    }
    if (kind === 'image' && !/\.png$/i.test(rawPath)) {
      return { ok: false, error: `${label} 是 image 卡：path 必须是项目内的 PNG 文件（收到 ${rawPath || '（缺失）'}）` }
    }
    if (kind === 'pdf-text' && !/\.pdf$/i.test(rawPath)) {
      return { ok: false, error: `${label} 是 pdf-text 卡：path 必须是项目内的 .pdf 文件（收到 ${rawPath || '（缺失）'}）` }
    }
    const resource = resolveEvidenceResource(raw, { targetDir, allowedOrigins, label })
    if (!resource.ok) return { ok: false, error: resource.error }
    warnings.push(...resource.warnings)
    let width = null
    let height = null
    if (kind === 'screenshot' || kind === 'interaction') {
      width = normalizeDimension(raw.width, DEFAULT_WIDTH, warnings, `${label} 的 width`)
      height = normalizeDimension(raw.height, DEFAULT_HEIGHT, warnings, `${label} 的 height`)
    } else if (kind === 'pdf-text') {
      width = normalizeDimension(raw.width, PDF_DEFAULT_WIDTH, warnings, `${label} 的 width`)
      height = normalizeDimension(raw.height, PDF_DEFAULT_HEIGHT, warnings, `${label} 的 height`)
    }
    let pdfPage = null
    if (kind === 'pdf-text') {
      if (raw.page === undefined || raw.page === null) {
        pdfPage = 1
      } else {
        const numeric = typeof raw.page === 'number' ? raw.page : (typeof raw.page === 'string' && raw.page.trim() !== '' ? Number(raw.page) : Number.NaN)
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_PDF_PAGE_NUMBER) {
          return { ok: false, error: `${label} 的 page 必须是 ≥1 的整数（PDF 页码，从 1 开始）` }
        }
        pdfPage = numeric
      }
    }
    const defaultName = kind === 'image'
      ? path.basename(rawPath).replace(/\.png$/i, '') || `image-${index + 1}`
      : kind === 'pdf-text'
        ? `pdf-page-${pdfPage}`
        : `evidence-${index + 1}`
    const rawName = typeof raw.name === 'string' && raw.name.trim() !== ''
      ? truncateText(raw.name.trim(), 64)
      : truncateText(defaultName, 64)
    let steps = []
    if (kind === 'interaction') {
      const normalizedSteps = normalizeSteps(raw.steps, label, {
        targetDir,
        allowedOrigins,
        cardUrl: resource.url,
        cardPage: resource.page,
      })
      if (!normalizedSteps.ok) return { ok: false, error: normalizedSteps.error }
      warnings.push(...normalizedSteps.warnings)
      steps = normalizedSteps.steps
    } else if (raw.steps !== undefined && raw.steps !== null && (!Array.isArray(raw.steps) || raw.steps.length > 0)) {
      warnings.push(`${label} 是 ${kind} 卡：steps 已忽略（脚本化状态请使用 interaction 卡）`)
    }
    cards.push({
      index,
      name: rawName,
      slug: slugifyName(rawName, `evidence-${index + 1}`),
      kind,
      width,
      height,
      path: resource.path,
      url: resource.url,
      page: resource.page,
      pdfPage,
      collect: normalizeCollect(raw.collect),
      steps,
    })
  }
  const plannedArtifacts = cards.reduce((total, card) => {
    if (card.kind === 'interaction') {
      const screenshots = card.steps.filter((step) => step.action === 'screenshot').length
      return total + Math.max(1, screenshots)
    }
    // pdf-text writes one rendered PNG plus one extracted `.txt` artifact.
    if (card.kind === 'pdf-text') return total + 2
    return total + 1
  }, 0)
  if (plannedArtifacts > maxArtifacts) {
    return { ok: false, error: `本轮证据文件总数 ${plannedArtifacts} 超过上限 ${maxArtifacts}：请减少 interaction 卡里的 screenshot 步骤或 pdf-text 卡数量（每卡至少 1 张图）` }
  }
  return { ok: true, cards, warnings }
}

/** Map legacy `shots` specs (already normalized by shots.js) to screenshot cards. */
export function normalizeShotSpecsToCards(specs, options = {}) {
  const { targetDir = '' } = isPlainObject(options) ? options : {}
  if (!Array.isArray(specs)) return []
  return specs.map((spec, index) => {
    const isUrl = spec?.kind === 'url'
    const resource = isUrl
      ? { path: null, url: String(spec.url ?? ''), page: String(spec.page ?? spec.url ?? '') }
      : {
        path: typeof spec?.path === 'string' ? spec.path : path.resolve(targetDir, String(spec?.page ?? '')),
        url: pathToFileUrl(typeof spec?.path === 'string' ? spec.path : path.resolve(targetDir, String(spec?.page ?? ''))),
        page: String(spec?.page ?? ''),
      }
    const name = typeof spec?.name === 'string' && spec.name !== '' ? spec.name : `shot-${index + 1}`
    return {
      index,
      name: truncateText(name, 64),
      slug: slugifyName(name, `shot-${index + 1}`),
      kind: 'screenshot',
      width: integerOr(spec?.width, DEFAULT_WIDTH),
      height: integerOr(spec?.height, DEFAULT_HEIGHT),
      path: resource.path,
      url: resource.url,
      page: resource.page,
      collect: { console: false, network: false, perf: false },
      steps: [],
    }
  })
}

/** Build the CDP card payload from a normalized card (interaction runner input). */
export function toInteractionCard(card) {
  return {
    kind: 'interaction',
    name: card.name,
    slug: card.slug,
    width: card.width,
    height: card.height,
    url: card.url,
    page: card.page,
    collect: { ...card.collect },
    steps: card.steps.map((step) => ({ ...step })),
  }
}

/** Legacy `round.shots` record from the representative artifact of a card. */
export function shotFromArtifact(card, artifact, now = Date.now()) {
  if (!isPlainObject(card) || !isPlainObject(artifact)) return null
  const file = path.basename(String(artifact.file))
  const shotPath = typeof artifact.path === 'string' && artifact.path !== '' ? artifact.path : ''
  return {
    file,
    path: shotPath,
    url: typeof artifact.url === 'string' && artifact.url !== '' ? artifact.url : (shotPath === '' ? '' : pathToFileUrl(shotPath)),
    width: integerOr(artifact.width, 0),
    height: integerOr(artifact.height, 0),
    bytes: integerOr(artifact.bytes, 0),
    sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : undefined,
    page: typeof card.page === 'string' ? card.page : '',
    renderedAt: now,
  }
}

/** Synthesize evidence cards from already-rendered legacy shot records. */
export function buildEvidenceFromShots(options = {}) {
  const { shots, requiredShots = 4 } = isPlainObject(options) ? options : {}
  if (!Array.isArray(shots) || shots.length === 0) return { ok: false, error: '没有可转换的截图记录' }
  if (shots.length !== requiredShots) {
    return { ok: false, error: `截图数量 ${shots.length} 与要求的证据卡数 ${requiredShots} 不一致` }
  }
  const evidence = shots.map((shot, index) => {
    const file = path.basename(String(shot.file ?? ''))
    const page = typeof shot.page === 'string' ? shot.page : ''
    return {
      index,
      name: truncateText(page !== '' ? page : file, 64),
      kind: 'screenshot',
      artifacts: [{
        file,
        path: typeof shot.path === 'string' ? shot.path : '',
        width: integerOr(shot.width, 0),
        height: integerOr(shot.height, 0),
        bytes: integerOr(shot.bytes, 0),
        sha256: typeof shot.sha256 === 'string' ? shot.sha256 : null,
        mime: 'image/png',
        kind: 'screenshot',
        stepName: null,
      }],
      meta: emptyEvidenceMeta({ url: typeof shot.url === 'string' ? shot.url : '', page }),
    }
  })
  return { ok: true, evidence }
}

function artifactFromRenderedShot(shot, shotDir) {
  const file = path.basename(String(shot?.file ?? ''))
  return {
    file,
    path: typeof shot?.path === 'string' && shot.path !== '' ? shot.path : path.join(shotDir, file),
    width: integerOr(shot?.width, 0),
    height: integerOr(shot?.height, 0),
    bytes: integerOr(shot?.bytes, 0),
    sha256: typeof shot?.sha256 === 'string' ? shot.sha256 : null,
    mime: 'image/png',
    kind: 'screenshot',
    stepName: null,
  }
}

function screenshotEvidenceCard(card, artifacts) {
  return {
    index: card.index,
    name: card.name,
    kind: 'screenshot',
    artifacts,
    meta: emptyEvidenceMeta({ url: card.url, page: card.page }),
  }
}

/** Bound the interaction runner's metadata before it is persisted/forwarded. */
export function normalizeEvidenceMeta(rawMeta, card = null) {
  const source = isPlainObject(rawMeta) ? rawMeta : {}
  const consoleSource = isPlainObject(source.console) ? source.console : {}
  const networkSource = isPlainObject(source.network) ? source.network : {}
  const perfSource = isPlainObject(source.perf) ? source.perf : {}
  const metrics = {}
  if (isPlainObject(perfSource.metrics)) {
    for (const [key, value] of Object.entries(perfSource.metrics)) {
      if (Object.keys(metrics).length >= 12) break
      if (typeof key !== 'string' || key === '' || !Number.isFinite(value)) continue
      metrics[truncateText(key, 80)] = value
    }
  }
  const steps = []
  if (Array.isArray(source.steps)) {
    for (const step of source.steps) {
      if (steps.length >= LIMITS.maxEvidenceStepsPerCard + 2) break
      if (!isPlainObject(step)) continue
      const compact = { action: truncateText(typeof step.action === 'string' ? step.action : 'unknown', 24) }
      if (typeof step.selector === 'string') compact.selector = truncateText(step.selector, 200)
      if (typeof step.key === 'string') compact.key = truncateText(step.key, 32)
      if (typeof step.name === 'string') compact.name = truncateText(step.name, 64)
      if (typeof step.file === 'string') compact.file = truncateText(step.file, 80)
      if (typeof step.tag === 'string') compact.tag = truncateText(step.tag, 32)
      if (Number.isFinite(step.ms)) compact.ms = Math.max(0, Math.round(step.ms))
      steps.push(compact)
    }
  }
  return {
    url: truncateText(typeof source.url === 'string' && source.url !== '' ? source.url : (card?.url ?? ''), 1000),
    page: truncateText(typeof source.page === 'string' ? source.page : (card?.page ?? ''), 500),
    console: {
      events: stringArray(consoleSource.events, LIMITS.maxEvidenceConsoleEvents, LIMITS.evidenceEventChars),
      errors: Math.max(0, Math.round(numberOr(consoleSource.errors, 0))),
      truncated: consoleSource.truncated === true,
    },
    network: {
      requests: Math.max(0, Math.round(numberOr(networkSource.requests, 0))),
      failures: Math.max(0, Math.round(numberOr(networkSource.failures, 0))),
      truncated: networkSource.truncated === true,
      failureSamples: stringArray(networkSource.failureSamples, LIMITS.maxEvidenceFailureSamples, LIMITS.evidenceEventChars),
    },
    perf: {
      metrics,
      fps: Number.isFinite(perfSource.fps) ? Math.round(perfSource.fps * 100) / 100 : null,
    },
    steps,
  }
}

function cardToShotSpec(card) {
  return card.path !== null && card.path !== undefined
    ? { kind: 'path', path: card.path, width: card.width, height: card.height, name: card.name, page: card.page }
    : { kind: 'url', url: card.url, width: card.width, height: card.height, name: card.name, page: card.page }
}

function screenshotTimeoutMs(config) {
  const seconds = Number.isFinite(config?.screenshotTimeoutSeconds) && config.screenshotTimeoutSeconds > 0
    ? config.screenshotTimeoutSeconds
    : 45
  return Math.max(5, Math.round(seconds)) * 1000
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * v1.2 2.3b `image` evidence card: copy one project-local PNG into the cycle
 * evidence dir as the representative image. No browser is involved.
 * @returns {Promise<{ok: boolean, artifacts?: object[], evidenceCard?: object, shot?: object, error?: string}>}
 */
export async function renderImageEvidenceCard(options = {}) {
  const { card, shotDir, roundNo = 1, shotIndex = 1, fsImpl = fs, now = Date.now } = isPlainObject(options) ? options : {}
  if (!isPlainObject(card) || card.kind !== 'image') return { ok: false, error: 'renderImageEvidenceCard 需要 kind=image 的证据卡' }
  if (typeof card.path !== 'string' || card.path === '') return { ok: false, error: 'image 证据卡缺少 path' }
  let bytes = null
  try {
    bytes = await fsImpl.readFile(card.path)
  } catch (error) {
    return { ok: false, error: `image 证据卡读取失败（${card.page}）：${error?.code === 'ENOENT' ? '文件不存在' : (error?.message || error)}` }
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length > LIMITS.evidenceImageMaxBytes) {
    return { ok: false, error: `image 证据卡文件超过上限（${bytes.length} 字节 > ${LIMITS.evidenceImageMaxBytes} 字节）：${card.page}` }
  }
  if (bytes.length <= MIN_PNG_BYTES) {
    return { ok: false, error: `image 证据卡 PNG 过小（${bytes.length} 字节，要求 > ${MIN_PNG_BYTES} 字节）：${card.page}` }
  }
  const dimensions = pngDimensions(bytes)
  if (dimensions === null) return { ok: false, error: `image 证据卡不是有效的 PNG：${card.page}` }
  const file = buildShotFilename(roundNo, Math.max(0, shotIndex - 1), card.name)
  const artifactPath = path.join(shotDir, file)
  try {
    await fsImpl.writeFile(artifactPath, bytes)
  } catch (error) {
    return { ok: false, error: `image 证据卡写入证据目录失败：${error?.message || error}` }
  }
  const artifact = {
    file,
    path: artifactPath,
    width: dimensions.width,
    height: dimensions.height,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png',
    kind: 'image',
    stepName: null,
  }
  const evidenceCard = {
    index: card.index,
    name: card.name,
    kind: 'image',
    artifacts: [artifact],
    meta: emptyEvidenceMeta({ url: '', page: card.page }),
  }
  return { ok: true, artifacts: [artifact], evidenceCard, shot: shotFromArtifact(card, artifact, now()) }
}

/**
 * v1.2 2.3b `pdf-text` evidence card: zero-dependency PDF text extraction, one
 * escaped HTML text page rendered to a representative PNG (existing shots path)
 * plus a `r<N>-s<K>-pdf.txt` extracted-text artifact.
 * @returns {Promise<{ok: boolean, artifacts?: object[], evidenceCard?: object, shot?: object, error?: string}>}
 */
export async function renderPdfTextEvidenceCard(options = {}) {
  const {
    card,
    stateDir,
    cycleId,
    shotDir,
    roundNo = 1,
    shotIndex = 1,
    shotIndexOffset = null,
    config = {},
    renderShotsImpl = defaultRenderShots,
    extractPdfTextImpl = extractPdfText,
    fsImpl = fs,
    now = Date.now,
  } = isPlainObject(options) ? options : {}
  if (!isPlainObject(card) || card.kind !== 'pdf-text') return { ok: false, error: 'renderPdfTextEvidenceCard 需要 kind=pdf-text 的证据卡' }
  let extraction = null
  try {
    extraction = await extractPdfTextImpl(card.path, { fsImpl })
  } catch (error) {
    return { ok: false, error: `PDF 文本提取异常（${card.page}）：${error?.message || error}` }
  }
  if (!isPlainObject(extraction) || extraction.ok !== true) {
    return { ok: false, error: `PDF 文本提取失败（${card.page}）：${extraction?.error || '未知错误'}` }
  }
  const pageNumber = Number.isInteger(card.pdfPage) && card.pdfPage > 0 ? card.pdfPage : 1
  if (pageNumber > extraction.pageCount) {
    return { ok: false, error: `PDF 只有 ${extraction.pageCount} 页，无法渲染第 ${pageNumber} 页：${card.page}` }
  }
  const pageText = typeof extraction.pages?.[pageNumber - 1] === 'string' ? extraction.pages[pageNumber - 1] : ''
  const tmpDir = path.join(path.resolve(stateDir), 'tmp')
  const stamp = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const htmlFile = path.join(tmpDir, `${stamp}-r${roundNo}-p${shotIndex}-${card.slug}.html`)
  const visiblePage = typeof card.page === 'string' ? card.page : path.basename(String(card.path ?? 'paper.pdf'))
  const title = `${visiblePage} — 第 ${pageNumber}/${extraction.pageCount} 页`
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${escapeHtmlText(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #ffffff; color: #1b1b1b; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 18px; }
  header h1 { font-size: 20px; margin: 0 0 6px; }
  header p { margin: 0; font-size: 12px; color: #555; word-break: break-all; }
  main pre { white-space: pre-wrap; word-break: break-word; font: 14px/1.55 "Cascadia Mono", Consolas, "Courier New", monospace; margin: 0; }
  footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #bbb; font-size: 11px; color: #666; }
</style></head>
<body>
<header><h1>${escapeHtmlText(title)}</h1><p>PDF：${escapeHtmlText(visiblePage)}；提取字符数：${pageText.length}；PDF sha256：${extraction.sha256}</p></header>
<main><pre>${escapeHtmlText(pageText || '（该页未提取到文本）')}</pre></main>
<footer>Host 零依赖 PDF 文本提取（不执行 PDF 内嵌脚本/字体）；仅用于评审证据。</footer>
</body></html>`
  try {
    await fsImpl.mkdir(tmpDir, { recursive: true })
    await fsImpl.writeFile(htmlFile, html, 'utf8')
    const rendered = await renderShotsImpl({
      cycleId,
      roundNo,
      stateDir,
      specs: [{
        kind: 'path',
        path: htmlFile,
        width: card.width,
        height: card.height,
        name: card.name,
        page: `pdf:${visiblePage}#${pageNumber}`,
      }],
      requiredShots: 1,
      shotIndexOffset: Number.isInteger(shotIndexOffset) ? shotIndexOffset : Math.max(0, shotIndex - 1),
      cleanBefore: false,
      chromePath: typeof config?.chromePath === 'string' ? config.chromePath : '',
      timeoutMs: screenshotTimeoutMs(config),
      fsImpl,
      now,
    })
    let pngArtifact = null
    if (rendered?.ok === true && Array.isArray(rendered.shots) && isPlainObject(rendered.shots[0])) {
      pngArtifact = { ...artifactFromRenderedShot(rendered.shots[0], shotDir), kind: 'pdf-text' }
    } else {
      const detail = typeof rendered?.error === 'string' && rendered.error !== ''
        ? rendered.error
        : (Array.isArray(rendered?.errors) && typeof rendered.errors[0] === 'string' ? rendered.errors[0] : 'PDF 文本页截图失败')
      return { ok: false, error: `pdf-text 证据卡渲染失败（${visiblePage} 第 ${pageNumber} 页）：${detail}` }
    }
    const textFile = `r${roundNo}-s${shotIndex}-pdf.txt`
    const textContent = `PDF: ${visiblePage}\nPage: ${pageNumber} / ${extraction.pageCount}\nExtractedChars: ${pageText.length}\nTruncated: ${extraction.truncated === true ? 'yes' : 'no'}\nPDF-SHA256: ${extraction.sha256}\n\n${pageText}\n`
    const textBytes = Buffer.from(textContent, 'utf8')
    const textPath = path.join(shotDir, textFile)
    await fsImpl.writeFile(textPath, textBytes)
    const textArtifact = {
      file: textFile,
      path: textPath,
      width: 0,
      height: 0,
      bytes: textBytes.length,
      sha256: createHash('sha256').update(textBytes).digest('hex'),
      mime: 'text/plain',
      kind: 'text',
      stepName: null,
    }
    const meta = {
      ...emptyEvidenceMeta({ url: '', page: visiblePage }),
      pageCount: extraction.pageCount,
      page: pageNumber,
      extractedChars: pageText.length,
      truncated: extraction.truncated === true,
      pdfSha256: extraction.sha256,
    }
    const evidenceCard = {
      index: card.index,
      name: card.name,
      kind: 'pdf-text',
      artifacts: [pngArtifact, textArtifact],
      meta,
    }
    return {
      ok: true,
      artifacts: [pngArtifact, textArtifact],
      evidenceCard,
      shot: shotFromArtifact(card, pngArtifact, now()),
    }
  } catch (error) {
    return { ok: false, error: `pdf-text 证据卡渲染异常（${visiblePage}）：${error?.message || error}` }
  } finally {
    try {
      await fsImpl.unlink(htmlFile)
    } catch {
      // Best-effort cleanup of the temp text page.
    }
  }
}

/**
 * Render every evidence card for one round.
 *
 * The all-screenshot plan (legacy `shots`, auto-detected page, and 4 static
 * evidence cards) uses exactly ONE `renderShots` call — byte-for-byte the old
 * behaviour. Mixed plans render each card independently: screenshot cards via
 * `renderShots` (with `shotIndexOffset` so filenames keep the card index) and
 * interaction cards via the CDP runner.
 *
 * @returns {Promise<{ok: boolean, evidence: object[], shots: object[], artifactsCount: number,
 *                    errors: string[], warnings: string[], error?: string}>}
 */
export async function renderEvidenceCards(options = {}) {
  const {
    cards = null,
    specs = null,
    targetDir = '',
    stateDir,
    cycleId,
    roundNo = 1,
    requiredEvidence,
    config = {},
    chrome = null,
    resolveChrome = resolveChromePath,
    renderShotsImpl = defaultRenderShots,
    runInteractionCardImpl = defaultRunInteractionCard,
    extractPdfTextImpl = extractPdfText,
    fsImpl = fs,
    now = Date.now,
  } = isPlainObject(options) ? options : {}

  const warnings = []
  const errors = []
  const evidence = []
  const shots = []
  let artifactsCount = 0
  const fail = (message) => ({ ok: false, error: message, evidence, shots, artifactsCount, errors, warnings })

  try {
    if (typeof stateDir !== 'string' || stateDir.trim() === '') return fail('缺少 stateDir，无法保存证据')
    if (typeof cycleId !== 'string' || !SAFE_SEGMENT.test(cycleId)) return fail(`cycleId 不合法，拒绝写入证据目录：${String(cycleId)}`)
    const planCards = Array.isArray(cards) && cards.length > 0
      ? cards
      : normalizeShotSpecsToCards(specs, { targetDir })
    if (planCards.length === 0) return fail('没有可渲染的证据卡')
    if (Number.isInteger(requiredEvidence) && planCards.length !== requiredEvidence) {
      return fail(`证据卡数量 ${planCards.length} 与要求的 ${requiredEvidence} 不一致`)
    }
    const shotDir = path.join(path.resolve(stateDir), 'shots', cycleId)
    await fsImpl.mkdir(shotDir, { recursive: true })
    // Clean this round's leftovers only (`r<N>-*`); other rounds stay intact.
    await cleanRoundShots(shotDir, roundNo, { fsImpl })

    // The batched ONE-call screenshot path is only valid when every card is a
    // plain static screenshot (legacy shots / auto-detect / all-screenshot).
    const allScreenshot = planCards.every((card) => card.kind === 'screenshot')
    const needsBrowser = planCards.some((card) => card.kind === 'interaction' || card.kind === 'pdf-text')

    if (allScreenshot) {
      const specList = planCards.map(cardToShotSpec)
      let rendered = null
      try {
        rendered = await renderShotsImpl({
          cycleId,
          roundNo,
          stateDir,
          specs: specList,
          requiredShots: planCards.length,
          chromePath: typeof config?.chromePath === 'string' ? config.chromePath : '',
          timeoutMs: screenshotTimeoutMs(config),
          fsImpl,
          now,
        })
      } catch (error) {
        return fail(`证据渲染异常：${error?.message || error}`)
      }
      if (Array.isArray(rendered?.warnings)) warnings.push(...rendered.warnings)
      const renderedShots = Array.isArray(rendered?.shots) ? rendered.shots : []
      for (let index = 0; index < planCards.length; index += 1) {
        const card = planCards[index]
        const shot = renderedShots[index]
        if (!isPlainObject(shot)) {
          errors.push(`第 ${index + 1} 张证据没有产出图片`)
          continue
        }
        const artifact = artifactFromRenderedShot(shot, shotDir)
        evidence.push(screenshotEvidenceCard(card, [artifact]))
        shots.push(shotFromArtifact(card, artifact, now()))
        artifactsCount += 1
      }
      if (rendered?.ok !== true) {
        const detail = typeof rendered?.error === 'string' && rendered.error !== ''
          ? rendered.error
          : (Array.isArray(rendered?.errors) && typeof rendered.errors[0] === 'string' && rendered.errors[0] !== ''
            ? rendered.errors[0]
            : `证据渲染数量不足：需要 ${planCards.length} 张，实际 ${renderedShots.length} 张`)
        return fail(detail)
      }
      if (renderedShots.length !== planCards.length) {
        return fail(`证据渲染数量不足：需要 ${planCards.length} 张，实际 ${renderedShots.length} 张`)
      }
      return { ok: true, evidence, shots, artifactsCount, errors, warnings }
    }

    // Mixed plan: resolve the browser once for interaction/pdf-text cards.
    let chromeInfo = isPlainObject(chrome) ? chrome : null
    if (needsBrowser && chromeInfo === null) {
      // Tests inject the renderer/runner, so no real browser exists (and none is
      // launched); production always resolves the real binary here.
      if (runInteractionCardImpl !== defaultRunInteractionCard || renderShotsImpl !== defaultRenderShots) {
        chromeInfo = { path: 'injected' }
      } else {
        let resolution = null
        try {
          resolution = typeof resolveChrome === 'function'
            ? resolveChrome({ chromePath: typeof config?.chromePath === 'string' ? config.chromePath : '' })
            : null
        } catch (error) {
          resolution = { path: null, warnings: [`浏览器探测失败：${error?.message || error}`] }
        }
        if (!resolution || typeof resolution.path !== 'string' || resolution.path === '') {
          const detail = Array.isArray(resolution?.warnings) && resolution.warnings.length > 0
            ? ` ${resolution.warnings[resolution.warnings.length - 1]}`
            : ''
          return fail(`找不到可用的无头浏览器（Chrome/Edge），无法执行 interaction/pdf-text 证据卡。${detail}`)
        }
        if (Array.isArray(resolution.warnings)) warnings.push(...resolution.warnings)
        chromeInfo = { path: resolution.path }
      }
    }

    for (let index = 0; index < planCards.length; index += 1) {
      const card = planCards[index]
      if (card.kind === 'screenshot') {
        let rendered = null
        try {
          rendered = await renderShotsImpl({
            cycleId,
            roundNo,
            stateDir,
            specs: [cardToShotSpec(card)],
            requiredShots: 1,
            shotIndexOffset: index,
            // The framework already cleaned this round once; per-card renders
            // must not delete the other cards' artifacts.
            cleanBefore: false,
            chromePath: typeof config?.chromePath === 'string' ? config.chromePath : '',
            timeoutMs: screenshotTimeoutMs(config),
            fsImpl,
            now,
          })
        } catch (error) {
          errors.push(`第 ${index + 1} 张证据渲染异常：${error?.message || error}`)
          return fail(errors[errors.length - 1])
        }
        if (Array.isArray(rendered?.warnings)) warnings.push(...rendered.warnings)
        const shot = Array.isArray(rendered?.shots) ? rendered.shots[0] : null
        if (rendered?.ok !== true || !isPlainObject(shot)) {
          const detail = typeof rendered?.error === 'string' && rendered.error !== '' ? rendered.error : '截图卡没有产出图片'
          errors.push(detail)
          return fail(detail)
        }
        const artifact = artifactFromRenderedShot(shot, shotDir)
        evidence.push(screenshotEvidenceCard(card, [artifact]))
        shots.push(shotFromArtifact(card, artifact, now()))
        artifactsCount += 1
        continue
      }

      if (card.kind === 'image') {
        const renderedImage = await renderImageEvidenceCard({
          card,
          shotDir,
          roundNo,
          shotIndex: index + 1,
          fsImpl,
          now,
        })
        if (renderedImage.ok !== true) {
          errors.push(renderedImage.error || `第 ${index + 1} 张 image 证据卡失败`)
          return fail(errors[errors.length - 1])
        }
        artifactsCount += renderedImage.artifacts.length
        if (artifactsCount > LIMITS.maxEvidenceArtifacts) {
          return fail(`本轮证据文件总数超过上限 ${LIMITS.maxEvidenceArtifacts}`)
        }
        evidence.push(renderedImage.evidenceCard)
        shots.push(renderedImage.shot)
        continue
      }

      if (card.kind === 'pdf-text') {
        const renderedPdf = await renderPdfTextEvidenceCard({
          card,
          stateDir,
          cycleId,
          shotDir,
          roundNo,
          shotIndex: index + 1,
          shotIndexOffset: index,
          config,
          renderShotsImpl,
          extractPdfTextImpl,
          fsImpl,
          now,
        })
        if (renderedPdf.ok !== true) {
          errors.push(renderedPdf.error || `第 ${index + 1} 张 pdf-text 证据卡失败`)
          return fail(errors[errors.length - 1])
        }
        artifactsCount += renderedPdf.artifacts.length
        if (artifactsCount > LIMITS.maxEvidenceArtifacts) {
          return fail(`本轮证据文件总数超过上限 ${LIMITS.maxEvidenceArtifacts}`)
        }
        evidence.push(renderedPdf.evidenceCard)
        shots.push(renderedPdf.shot)
        continue
      }

      let result = null
      try {
        result = await runInteractionCardImpl({
          card: toInteractionCard(card),
          targetDir,
          outDir: shotDir,
          roundNo,
          shotIndex: index + 1,
          chrome: chromeInfo,
          config,
          fsImpl,
          now,
        })
      } catch (error) {
        errors.push(`第 ${index + 1} 张交互证据异常：${error?.message || error}`)
        return fail(errors[errors.length - 1])
      }
      if (!isPlainObject(result) || result.ok !== true) {
        const detail = typeof result?.error === 'string' && result.error !== ''
          ? result.error
          : 'interaction 证据卡执行失败'
        errors.push(detail)
        return fail(detail)
      }
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter((artifact) => isPlainObject(artifact) && typeof artifact.file === 'string') : []
      if (artifacts.length === 0) {
        const detail = `第 ${index + 1} 张交互证据没有产出图片`
        errors.push(detail)
        return fail(detail)
      }
      artifactsCount += artifacts.length
      if (artifactsCount > LIMITS.maxEvidenceArtifacts) {
        return fail(`本轮证据文件总数超过上限 ${LIMITS.maxEvidenceArtifacts}`)
      }
      evidence.push({
        index: card.index,
        name: card.name,
        kind: 'interaction',
        artifacts: artifacts.map((artifact) => ({ ...artifact })),
        meta: normalizeEvidenceMeta(result.meta, card),
      })
      const representative = representativeArtifact(evidence[evidence.length - 1])
      const shot = shotFromArtifact(card, representative, now())
      if (shot === null) {
        const detail = `第 ${index + 1} 张交互证据缺少可用的代表图`
        errors.push(detail)
        return fail(detail)
      }
      shots.push(shot)
    }

    if (evidence.length !== planCards.length) return fail(`证据卡渲染不完整：${evidence.length}/${planCards.length}`)
    return { ok: true, evidence, shots, artifactsCount, errors, warnings }
  } catch (error) {
    errors.push(`证据流程异常：${error?.message || error}`)
    return fail(errors[errors.length - 1])
  }
}

/**
 * Orchestrator-side enforcement of the evidence invariant: every card has at
 * least one verified image, every file carries a matching sha256 and the total
 * is bounded. Mirrors `verifyRoundShotFiles` for the representative four.
 */
export async function verifyEvidenceArtifacts(options = {}) {
  const {
    evidence,
    shotsDir,
    requiredEvidence = 4,
    maxArtifacts = LIMITS.maxEvidenceArtifacts,
    minBytes = MIN_PNG_BYTES,
    fsImpl = fs,
  } = isPlainObject(options) ? options : {}
  if (!Array.isArray(evidence)) return { ok: false, count: 0, error: '缺少证据卡记录' }
  if (evidence.length !== requiredEvidence) {
    return { ok: false, count: evidence.length, error: `本轮证据卡 ${evidence.length} 张，必须恰好 ${requiredEvidence} 张` }
  }
  if (typeof shotsDir !== 'string' || shotsDir.trim() === '') return { ok: false, count: 0, error: '缺少证据目录' }
  const seen = new Set()
  let total = 0
  for (let index = 0; index < evidence.length; index += 1) {
    const card = evidence[index]
    if (!isPlainObject(card)) return { ok: false, count: total, error: `第 ${index + 1} 张证据卡记录不合法` }
    if (!EVIDENCE_KINDS.includes(card.kind)) return { ok: false, count: total, error: `第 ${index + 1} 张证据卡 kind 不合法：${String(card.kind)}` }
    if (!Array.isArray(card.artifacts) || card.artifacts.length === 0) {
      return { ok: false, count: total, error: `第 ${index + 1} 张证据卡没有图片产物（每卡至少 1 张）` }
    }
    let imageCount = 0
    for (const artifact of card.artifacts) {
      if (!isPlainObject(artifact) || typeof artifact.file !== 'string' || artifact.file === '') {
        return { ok: false, count: total, error: `第 ${index + 1} 张证据卡有产物缺少文件名` }
      }
      if (path.basename(artifact.file) !== artifact.file || !ANY_ARTIFACT.test(artifact.file)) {
        return { ok: false, count: total, error: `证据文件名不合法：${artifact.file}` }
      }
      if (seen.has(artifact.file)) return { ok: false, count: total, error: `证据文件名重复：${artifact.file}` }
      seen.add(artifact.file)
      total += 1
      if (total > maxArtifacts) return { ok: false, count: total, error: `本轮证据文件总数超过上限 ${maxArtifacts}` }
      // v1.2 2.3b: every artifact (image OR extracted-text file) must carry a
      // well-formed content hash that matches the bytes on disk.
      if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        return { ok: false, count: total, error: `证据 ${artifact.file} 缺少 sha256 内容哈希（新轮次必须记录证据哈希）` }
      }
      const absolutePath = path.join(shotsDir, artifact.file)
      if (IMAGE_ARTIFACT.test(artifact.file)) {
        imageCount += 1
        const verified = await verifyShotFile(absolutePath, {
          width: Number.isInteger(artifact.width) ? artifact.width : undefined,
          height: Number.isInteger(artifact.height) ? artifact.height : undefined,
          minBytes,
          fsImpl,
        })
        if (!verified.ok) return { ok: false, count: total, error: `证据 ${artifact.file} 校验失败：${verified.error}` }
        if (verified.sha256 !== artifact.sha256) {
          return { ok: false, count: total, error: `证据 ${artifact.file} 的 sha256 与文件内容不一致（证据可能被篡改）` }
        }
        if (artifact.mime !== undefined && artifact.mime !== 'image/png') {
          return { ok: false, count: total, error: `证据 ${artifact.file} 的 mime 不合法` }
        }
        continue
      }
      // Extracted-text artifact (PDF text): sha256 + exact byte size.
      if (artifact.mime !== undefined && artifact.mime !== 'text/plain') {
        return { ok: false, count: total, error: `证据 ${artifact.file} 的 mime 不合法（文本产物必须为 text/plain）` }
      }
      let data = null
      try {
        data = await fsImpl.readFile(absolutePath)
      } catch (error) {
        return { ok: false, count: total, error: `证据 ${artifact.file} 读取失败：${error?.code === 'ENOENT' ? '文件不存在' : (error?.message || error)}` }
      }
      if (!Buffer.isBuffer(data)) data = Buffer.from(data)
      const actualHash = createHash('sha256').update(data).digest('hex')
      if (actualHash !== artifact.sha256) {
        return { ok: false, count: total, error: `证据 ${artifact.file} 的 sha256 与文件内容不一致（证据可能被篡改）` }
      }
      if (Number.isInteger(artifact.bytes) && artifact.bytes !== data.length) {
        return { ok: false, count: total, error: `证据 ${artifact.file} 记录的字节数 ${artifact.bytes} 与文件 ${data.length} 不一致` }
      }
    }
    if (imageCount === 0) return { ok: false, count: total, error: `第 ${index + 1} 张证据卡没有图片产物（每卡至少 1 张）` }
  }
  return { ok: true, count: evidence.length, artifacts: total, error: null }
}

/** Compact Host-side manifest forwarded to the red team / judge prompts. */
export function buildEvidenceManifest(evidence) {
  if (!Array.isArray(evidence)) return []
  return evidence
    .filter((card) => isPlainObject(card))
    .map((card, index) => {
      const representative = representativeArtifact(card)
      const meta = isPlainObject(card.meta) ? card.meta : {}
      const consoleBlock = isPlainObject(meta.console) ? meta.console : {}
      const networkBlock = isPlainObject(meta.network) ? meta.network : {}
      const perfBlock = isPlainObject(meta.perf) ? meta.perf : {}
      const textArtifact = Array.isArray(card.artifacts)
        ? card.artifacts.find((artifact) => isPlainObject(artifact)
          && typeof artifact.file === 'string'
          && !artifact.file.toLowerCase().endsWith('.png'))
        : null
      const manifest = {
        index: Number.isInteger(card.index) ? card.index : index,
        name: truncateText(typeof card.name === 'string' ? card.name : `evidence-${index + 1}`, 64),
        kind: EVIDENCE_KINDS.includes(card.kind) ? card.kind : 'screenshot',
        artifactCount: Array.isArray(card.artifacts) ? card.artifacts.length : 0,
        file: representative === null ? '' : representative.file,
        // Absolute path for the REVIEWER prompts only (the guard confines reads
        // to the current cycle's evidence dir). Never exposed by compact/public.
        filePath: representative === null || typeof representative.path !== 'string' ? '' : representative.path,
        width: representative === null ? 0 : integerOr(representative.width, 0),
        height: representative === null ? 0 : integerOr(representative.height, 0),
        sha256: representative === null || typeof representative.sha256 !== 'string' ? '' : representative.sha256,
        consoleErrors: Math.max(0, Math.round(numberOr(consoleBlock.errors, 0))),
        consoleTruncated: consoleBlock.truncated === true,
        networkFailures: Math.max(0, Math.round(numberOr(networkBlock.failures, 0))),
        networkRequests: Math.max(0, Math.round(numberOr(networkBlock.requests, 0))),
        fps: Number.isFinite(perfBlock.fps) ? Math.round(perfBlock.fps * 100) / 100 : null,
        stepCount: Array.isArray(meta.steps) ? meta.steps.length : 0,
      }
      if (card.kind === 'pdf-text') {
        // Extraction provenance (numbers + a reviewer-readable text artifact).
        manifest.pageCount = integerOr(meta.pageCount, 0)
        manifest.page = integerOr(meta.page, 0)
        manifest.extractedChars = integerOr(meta.extractedChars, 0)
        manifest.pdfTruncated = meta.truncated === true
        manifest.pdfSha256 = typeof meta.pdfSha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.pdfSha256) ? meta.pdfSha256 : ''
        if (textArtifact !== null) {
          manifest.textFile = textArtifact.file
          manifest.textFilePath = typeof textArtifact.path === 'string' ? textArtifact.path : ''
        }
      }
      return manifest
    })
}

/**
 * Compact tool-result summary: no logs, no base64, no filesystem paths.
 * @returns {{cards: object[], cardCount: number, artifactCount: number,
 *            consoleErrors: number, networkFailures: number}|null}
 */
export function buildCompactEvidence(evidence) {
  if (!Array.isArray(evidence)) return null
  const cards = evidence
    .filter((card) => isPlainObject(card))
    .map((card, index) => {
      const meta = isPlainObject(card.meta) ? card.meta : {}
      const consoleBlock = isPlainObject(meta.console) ? meta.console : {}
      const networkBlock = isPlainObject(meta.network) ? meta.network : {}
      const perfBlock = isPlainObject(meta.perf) ? meta.perf : {}
      return {
        index: Number.isInteger(card.index) ? card.index : index,
        name: truncateText(typeof card.name === 'string' ? card.name : `evidence-${index + 1}`, 64),
        kind: EVIDENCE_KINDS.includes(card.kind) ? card.kind : 'screenshot',
        artifactCount: Array.isArray(card.artifacts) ? card.artifacts.length : 0,
        consoleErrorCount: Math.max(0, Math.round(numberOr(consoleBlock.errors, 0))),
        networkFailureCount: Math.max(0, Math.round(numberOr(networkBlock.failures, 0))),
        perfFps: Number.isFinite(perfBlock.fps) ? Math.round(perfBlock.fps * 100) / 100 : null,
      }
    })
  return {
    cards,
    cardCount: cards.length,
    artifactCount: cards.reduce((total, card) => total + card.artifactCount, 0),
    consoleErrors: cards.reduce((total, card) => total + card.consoleErrorCount, 0),
    networkFailures: cards.reduce((total, card) => total + card.networkFailureCount, 0),
  }
}
