/**
 * Host entry for @local/dsh-redteam-console.
 *
 * Registers, in order: the durable state store, the two agent tools, the Web
 * panel HTTP routes, the global system-prompt section, and the stop-gate tool
 * guard. Optional Host services (`webServer`, `subagents`, `systemPrompt`,
 * `workingDirectory`) are accessed defensively — a missing service degrades
 * gracefully instead of throwing from `apply`.
 *
 * Conventions: no Config export (the Loader passes a plain object), no new
 * dependencies. A missing optional service degrades gracefully, but invalid
 * configuration that fails strict validation (e.g. judgeModels) is re-thrown
 * so the Loader reports the configuration error instead of silently running
 * with defaults.
 */

import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'

import {
  DEFAULT_CONFIG,
  EVIDENCE_KINDS,
  HTTP_PREFIX,
  LIMITS,
  MODELING_RUN_FILE,
  PROFILES,
  ROUND_MODES,
  TOOL_BATCH,
  TOOL_PROBE,
  TOOL_ROUND,
  TOOL_STATUS,
} from './lib/constants.js'
import { SYSTEM_PROMPT_SECTION } from './lib/prompts.js'
import { runReviewProbe } from './lib/probe.js'
import { evaluateReviewerAccess, lookupReviewChild } from './lib/review-registry.js'
import { isPlainObject, truncateText } from './lib/rubric.js'
import {
  createHttpHandler,
} from './lib/routes.js'
import {
  buildStatusSummary,
  runReviewBatch,
  runReviewRound,
} from './lib/orchestrate.js'
import { computeSnapshotSync } from './lib/snapshot.js'
import {
  createStore,
  cycleDeliverableRoot,
  isPathInsideOrEqual,
  latestRoundOf,
  listCycles,
  newestCycleByDeliverableRoot,
  newestCycleForDeliverable,
  resolveStateDir,
  targetKey,
} from './lib/store.js'

/** The tools registry is the one hard dependency (CONTRACT.md §2.1). */
export const inject = ['tools']

// One round may run 1 attacker + judgeSamples judges sequentially, each with
// its own roundTimeoutSeconds budget, plus up to 4 evidence cards rendered
// serially (each card up to interactionTimeoutSeconds). Keep the outer tool
// timeout strictly above the worst documented case:
//   (1 + maxJudgeSamples=3) × roundTimeoutSeconds max 2160s = 8640s
//   + 4 × interactionTimeoutSeconds max 600s = 2400s  → 11040s
// 9000s was too small; 14_400_000ms (4h) leaves a comfortable margin.
const ROUND_TIMEOUT_MS = 14_400_000
const STATUS_TIMEOUT_MS = 30_000
// review_probe run-tests is bounded by probeTimeoutSeconds (max 600s) plus the
// temp-copy time; keep the outer tool timeout comfortably above the worst case.
const PROBE_TIMEOUT_MS = 900_000

const NUMBER_RULES = Object.freeze({
  requiredScore: { min: 0, max: 100, integer: false },
  requiredFindings: { min: 1, max: 40, integer: true },
  requiredShots: { min: 1, max: LIMITS.maxShots, integer: true },
  maxRounds: { min: 1, max: LIMITS.maxRoundsPerCycle, integer: true },
  roundTimeoutSeconds: { min: 30, max: 2160, integer: true },
  screenshotTimeoutSeconds: { min: 5, max: 300, integer: true },
  // v1.2 2.2: hard per-interaction-card budget (browser spawn → steps → teardown).
  interactionTimeoutSeconds: { min: 1, max: 600, integer: true },
  // v1.2 2.4: per-command timeout for `review_probe run-metrics` (sandbox copy).
  modelingTimeoutSeconds: { min: 1, max: 600, integer: true },
  judgeSamples: { min: 1, max: LIMITS.maxJudgeSamples, integer: true },
  snapshotMaxFiles: { min: 1, max: 200000, integer: true },
  snapshotMaxHashBytes: { min: 1024, max: 10 * 1024 * 1024 * 1024, integer: true },
  snapshotMaxFileBytes: { min: 1024, max: 1024 * 1024 * 1024, integer: true },
  // v1.1 1.5: review_probe bounds.
  probeTimeoutSeconds: { min: 5, max: LIMITS.probeMaxTimeoutSeconds, integer: true },
  probeMaxCopyBytes: { min: 1024, max: 2 * 1024 * 1024 * 1024, integer: true },
  probeMaxCopyFiles: { min: 1, max: 200000, integer: true },
  // v1.3 3.2/3.4: incremental review + batch bounds.
  incrementalMaxChangedFiles: { min: 1, max: 100000, integer: true },
  maxBatchTargets: { min: 2, max: LIMITS.maxBatchTargets, integer: true },
  // v2.0 Stage A: drift thresholds (absolute negative deltas that alert).
  driftScoreDelta: { min: 0.1, max: 100, integer: false },
  driftRecallDelta: { min: 0, max: 1, integer: false },
  driftPassRateDelta: { min: 0, max: 1, integer: false },
})
const STRING_KEYS = Object.freeze([
  'childProvider',
  'attackerPreset',
  'judgePreset',
  'chromePath',
  'stateDir',
  // Optional child model routing (`''` = inherit the parent route).
  'attackerProvider',
  'attackerModel',
  'attackerReasoningEffort',
  'judgeProvider',
  'judgeModel',
  'judgeReasoningEffort',
])

/**
 * v2.0 Stage A: strict `judgeModels` validation.
 *
 * The list must be an array (≤ LIMITS.maxJudgeModels) of plain objects with
 * only the optional `provider` / `model` / `reasoningEffort` string fields.
 * Unlike the lenient scalar config keys, invalid entries throw a clear error:
 * a silently dropped per-sample route would make the multi-model audit lie.
 */
function validateJudgeModels(value) {
  if (value === undefined) return DEFAULT_CONFIG.judgeModels
  if (!Array.isArray(value)) {
    throw new Error('配置 judgeModels 必须是数组（最多 3 个 {provider?,model?,reasoningEffort?} 对象）')
  }
  if (value.length > LIMITS.maxJudgeModels) {
    throw new Error(`配置 judgeModels 最多 ${LIMITS.maxJudgeModels} 个对象（收到 ${value.length} 个）`)
  }
  const allowed = ['provider', 'model', 'reasoningEffort']
  const output = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isPlainObject(entry)) {
      throw new Error(`配置 judgeModels[${index}] 必须是对象（{provider?,model?,reasoningEffort?}）`)
    }
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) {
        throw new Error(`配置 judgeModels[${index}] 含未知字段「${truncateText(String(key), 60)}」；只允许 provider/model/reasoningEffort`)
      }
    }
    const route = {}
    for (const key of allowed) {
      if (entry[key] === undefined) continue
      if (typeof entry[key] !== 'string') {
        throw new Error(`配置 judgeModels[${index}].${key} 必须是字符串`)
      }
      const text = entry[key].trim()
      if (text === '') {
        throw new Error(`配置 judgeModels[${index}].${key} 不能为空字符串`)
      }
      if (text.length > 200) {
        throw new Error(`配置 judgeModels[${index}].${key} 过长（最多 200 字符）`)
      }
      route[key] = text
    }
    output.push(Object.freeze(route))
  }
  return Object.freeze(output)
}

/**
 * Sanitize one array-valued config key (`deliverableRoots`, `allowedOrigins`).
 * Every entry must be a non-empty string; roots become absolute paths, origins
 * must parse as http(s). Invalid entries are dropped rather than throwing.
 */
function sanitizeConfigArray(key, value, fallback) {
  if (!Array.isArray(value)) return fallback
  const output = []
  const seen = new Set()
  for (const raw of value) {
    if (output.length >= 100) break
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (text === '') continue
    let normalized = ''
    if (key === 'deliverableRoots' || key === 'goalGateRoots') {
      // v2.0: goalGateRoots must be absolute; a relative entry would silently
      // resolve against the Host process cwd and could widen/narrow the gate.
      if (key === 'goalGateRoots' && !path.isAbsolute(text)) continue
      try {
        normalized = path.resolve(text)
      } catch {
        continue
      }
    } else {
      try {
        const parsed = new URL(text)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
        normalized = parsed.origin
      } catch {
        continue
      }
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return Object.freeze(output)
}

/**
 * Merge the Loader-supplied plain config over DEFAULT_CONFIG.
 * Unknown keys are ignored; every value is bounded so hostile config cannot
 * break the plugin. Exported for tests.
 */
export function buildEffectiveConfig(rawConfig) {
  const source = isPlainObject(rawConfig) ? rawConfig : {}
  const effective = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const fallback = DEFAULT_CONFIG[key]
    const value = source[key]
    if (typeof fallback === 'boolean') {
      effective[key] = typeof value === 'boolean' ? value : fallback
    } else if (typeof fallback === 'number') {
      const numeric = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
      const rule = NUMBER_RULES[key]
      if (!Number.isFinite(numeric)) {
        effective[key] = fallback
      } else if (rule === undefined) {
        effective[key] = numeric
      } else {
        const clamped = Math.min(rule.max, Math.max(rule.min, numeric))
        effective[key] = rule.integer ? Math.round(clamped) : clamped
      }
    } else if (Array.isArray(fallback)) {
      // v2.0: judgeModels is validated strictly (throws), unlike the lenient
      // roots/origins arrays whose invalid entries are merely dropped.
      effective[key] = key === 'judgeModels' ? validateJudgeModels(value) : sanitizeConfigArray(key, value, fallback)
    } else if (typeof fallback === 'string') {
      if (key === 'profile') {
        // v1.2 2.3a: only the documented domain profiles are accepted; an
        // unknown value falls back to `code` instead of injecting a random path.
        const wanted = typeof value === 'string' ? value.trim() : ''
        effective[key] = PROFILES.includes(wanted) ? wanted : fallback
      } else {
        effective[key] = STRING_KEYS.includes(key) && typeof value === 'string' ? value : fallback
      }
    } else {
      effective[key] = fallback
    }
  }
  return Object.freeze(effective)
}

function createLogger(ctx) {
  const emit = (level, message, error) => {
    const line = `[adversarial-review] ${message}${error === undefined || error === null ? '' : `：${error?.message || error}`}`
    try {
      const logger = ctx?.logger
      if (logger && typeof logger[level] === 'function') {
        logger[level](line)
        return
      }
    } catch {
      // Fall through to console.
    }
    try {
      if (level === 'info') console.info(line)
      else console.warn(line)
    } catch {
      // Logging must never throw from apply().
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message, error) => emit('warn', message, error),
  }
}

function textRender(_args, value) {
  let text = ''
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text }]
}

const ROUND_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      description: '被评审项目的绝对路径；也允许相对调用方工作目录的路径。必填。',
    },
    title: {
      type: 'string',
      description: '展示名（可选），用于评审台和报告页标题。',
    },
    profile: {
      type: 'string',
      enum: PROFILES,
      description: '本轮领域 profile（可选；留空用插件配置默认值）。game 会注入游戏 rubric 并强调 interaction 证据。',
    },
    mode: {
      type: 'string',
      enum: ROUND_MODES,
      description: '生命周期模式（可选，默认 fresh）：fresh 继续/创建普通 cycle；reopen 在同一 target 的已通过 cycle 之后创建新 cycle（轮数上限重置、可复评）；incremental 在 reopen 基础上按上一通过轮的快照文件清单做变更焦点 + 回归抽样。reopen/incremental 需要该 target 已有 gate.passed=true 的 cycle。',
    },
    claims: {
      type: 'array',
      items: { type: 'string' },
      description: 'README/方案里要逐条证伪的「宣称」（可选，建议 3–10 条）。',
    },
    focus: {
      type: 'array',
      items: { type: 'string' },
      description: '重点攻击面（可选），如：可访问性、前端密钥、测试真实性、边界输入。',
    },
    outOfScope: {
      type: 'string',
      description: '明确不在本轮范围内的内容（可选）。',
    },
    environment: {
      type: 'string',
      description: '红队可用环境说明（可选），如：只读文件浏览 + 可运行已有测试；无浏览器控制。',
    },
    timeBudget: {
      type: 'string',
      description: '时间预算（可选），默认约 15–20 分钟或 40 次工具调用。',
    },
    shots: {
      type: 'array',
      description: '恰好 4 个截图规格（{path?|url?, width?, height?, name?}，path 相对 target 解析，url 仅 http(s)，二者互斥）。留空时自动探测 index.html/public/index.html/dist/index.html/src/index.html 并用 4 个视口渲染；都找不到则在判官结束后渲染 4 张评审报告页。与 evidence 二选一。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '页面文件路径（相对 target，必须位于 target 内；与 url 互斥）。' },
          url: { type: 'string', description: '页面 URL（仅 http/https；与 path 互斥）。' },
          width: { type: 'integer', description: '视口宽度（默认 1280）。' },
          height: { type: 'integer', description: '视口高度（默认 800）。' },
          name: { type: 'string', description: '截图名称/文件名 slug（可选）。' },
        },
      },
    },
    evidence: {
      type: 'array',
      description: '恰好 4 张证据卡（与 shots 二选一；两者都提供会报 arguments 错误）：kind=screenshot（静态图）/ interaction（脚本化步骤 + 多帧 + console/network/perf）/ image（target 内项目 PNG 图片，按文件实际尺寸拷入证据目录）/ pdf-text（target 内 PDF，零依赖抽取文本并渲染成文本页 PNG + 提取文本）。每卡必须产出至少 1 张图片；interaction 无 screenshot 步骤时自动在最后截一张。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '卡片名称（可选，≤64，用作文件名 slug 与 manifest 展示名）。' },
          kind: { type: 'string', enum: EVIDENCE_KINDS, description: '证据类型：截图 / 交互 / 项目图片 / PDF 文本页。' },
          path: { type: 'string', description: '页面/项目文件路径（相对 target，必须位于 target 内；image 必须是 .png，pdf-text 必须是 .pdf；与 url 互斥）。' },
          url: { type: 'string', description: '页面 URL（仅 http(s)，loopback 或 config.allowedOrigins 白名单；与 path 互斥；image/pdf-text 不支持 url）。' },
          width: { type: 'integer', description: '视口/文本页宽度（screenshot/interaction 默认 1440，pdf-text 默认 1200，范围 100–8000；image 使用文件实际尺寸）。' },
          height: { type: 'integer', description: '视口/文本页高度（screenshot/interaction 默认 900，pdf-text 默认 1600，范围 100–8000；image 使用文件实际尺寸）。' },
          page: { type: 'integer', description: 'pdf-text 卡的 PDF 页码（从 1 开始，默认 1）。' },
          steps: {
            type: 'array',
            description: 'interaction 卡的脚本化步骤（最多 20 步；非 interaction 卡的 steps 会被忽略）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', enum: ['goto', 'wait', 'click', 'key', 'screenshot'], description: '步骤动作。' },
                path: { type: 'string', description: 'goto 步骤的页面路径（相对 target；与 url 互斥，省略则回到卡片页面）。' },
                url: { type: 'string', description: 'goto 步骤的 URL（仅 http(s) loopback/白名单；与 path 互斥）。' },
                selector: { type: 'string', description: 'click 步骤的 CSS 选择器（只执行 document.querySelector(selector).click()）。' },
                key: { type: 'string', description: 'key 步骤的按键（Space/Enter/Escape/Tab/方向键/单个字母或数字）。' },
                ms: { type: 'integer', description: 'wait 步骤的毫秒数（0–10000，默认 300）。' },
                name: { type: 'string', description: 'screenshot 步骤的产物名（可选）。' },
              },
              required: ['action'],
            },
          },
          collect: {
            type: 'object',
            additionalProperties: false,
            properties: {
              console: { type: 'boolean', description: '收集 console/Log（默认 true）。' },
              network: { type: 'boolean', description: '收集 network response/failure（默认 true）。' },
              perf: { type: 'boolean', description: '收集 Performance 指标与 1 秒 rAF fps 估算（默认 true）。' },
            },
          },
        },
        required: ['kind'],
      },
    },
  },
  required: ['target'],
})

const ROUND_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '本轮流程是否成功执行（不代表已达标）。' },
    cycleId: { type: 'string' },
    round: { type: 'integer' },
    target: { type: 'string' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          file: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          url: { type: 'string' },
        },
      },
    },
    evidence: {
      type: 'object',
      description: '证据卡紧凑摘要：{cards:[{index,name,kind,artifactCount,consoleErrorCount,networkFailureCount,perfFps}],cardCount,artifactCount,consoleErrors,networkFailures}（不含日志全文/路径）。kind 可为 screenshot/interaction/image/pdf-text。',
    },
    profile: { type: 'string', description: '本轮领域 profile（code|web|game|modeling；旧轮次为 null）。' },
    mode: { type: 'string', description: '本轮生命周期模式：fresh | reopen | incremental。' },
    reopen: { type: 'object', description: 'cycle 复开摘要：{reopenedFrom,reopenCount}。' },
    noise: { type: 'object', description: '自动降噪摘要：{rawFindings,dedupedFindings,suppressedCount,knownRepeats}。' },
    cost: { type: 'object', description: '成本摘要：totalMs/evidenceMs/attackMs/judgeMs/promptChars/judgePromptChars/attackChars/scoreChars/judgeSamples/artifactCount。' },
    incremental: { type: 'object', description: '增量评审摘要：mode/baseCycleId/baseRound/changedCount/addedCount/removedCount/truncated/fullReview/unchangedCount。' },
    attack: { type: 'object' },
    score: { type: 'object' },
    scoreStats: {
      type: 'object',
      description: 'v2.0 多判官评分统计：{n,mean,median,stdev,min,max,ci95:{low,high}}（0–100，1 位小数；单判官时 CI 为单点）。门的保守聚合分仍是 score.score，本字段只用于审计/校准。',
    },
    gate: { type: 'object' },
    rubricVersion: { type: 'string', description: '本轮使用的评分规则版本，如 v2-100。' },
    promptHashes: { type: 'object', description: '本轮红队/判官提示词的 sha256（审计用）。' },
    modelRoute: { type: 'object', description: '本轮实际请求的子智能体模型路由：{attacker,judge,inherited,samples:[routePerJudge]}（未配置则为 inherited:true）。' },
    judges: {
      type: 'array',
      description: '每个判官样本的紧凑审计记录（完整记录在 state.json 的 round.judges；含每样本 modelRoute）。',
      items: { type: 'object' },
    },
    nextAction: { type: 'string' },
    message: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string', description: '失败阶段（仅 ok=false 时存在）。' },
    error: { type: 'string', description: '失败原因（仅 ok=false 时存在）。' },
    raw: { type: 'string', description: '无法解析的模型原始输出前 4000 字符（仅解析失败时存在）。' },
  },
  required: ['ok'],
})

const STATUS_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      description: '只看这个 target 的评审状态（可选；省略则返回最近的 cycle 列表）。',
    },
    limit: {
      type: 'integer',
      description: `最多返回多少个 cycle（1–${LIMITS.maxCycles}，默认 10）。`,
    },
  },
})

const STATUS_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    version: { type: 'integer' },
    generatedAt: { type: 'integer' },
    integrity: {
      type: 'object',
      description: 'state.json 完整性链状态：verified/hash/error（v1.1 1.4）。',
    },
    cycles: { type: 'array', items: { type: 'object' } },
    stage: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
})

const PROBE_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['run-tests', 'check-syntax', 'list-files', 'read-text', 'run-metrics'],
      description: '只读动作：run-tests（在只读临时副本中跑项目自带 npm test）、check-syntax（node --check 全部 js/mjs）、list-files（列出项目文件）、read-text（读取项目内单个文本文件）、run-metrics（在只读临时副本中按 modeling-run.json 声明的 commands 离线复跑并读取 metricsFile；用于建模复现验证）。',
    },
    path: {
      type: 'string',
      description: '可选路径参数（被评审项目内的相对路径或绝对路径；必须位于被评审项目目录内）。list-files 可指定子目录；read-text 必填文件路径。',
    },
    maxFiles: {
      type: 'integer',
      description: `list-files 最多返回多少个文件（默认 ${LIMITS.probeDefaultListFiles}，上限 ${LIMITS.probeMaxListFiles}）。`,
    },
    maxBytes: {
      type: 'integer',
      description: `read-text 最大读取字节数（默认 ${LIMITS.probeDefaultReadBytes}，上限 ${LIMITS.probeMaxReadBytes}）。`,
    },
  },
  required: ['action'],
})

const PROBE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    error: { type: 'string' },
    command: { type: 'string' },
    exitCode: { type: 'integer', description: '命令退出码（被终止或启动失败时可能缺失）。' },
    durationMs: { type: 'integer' },
    stdoutTail: { type: 'string' },
    stderrTail: { type: 'string' },
    copiedFiles: { type: 'integer' },
    copiedBytes: { type: 'integer' },
    truncated: { type: 'boolean' },
    checked: { type: 'integer' },
    failures: { type: 'array', items: { type: 'object' } },
    // v1.2 2.4: run-metrics sandbox fields.
    metrics: { type: 'object', description: '临时副本中读到的指标 JSON（run-metrics）。' },
    commands: { type: 'array', items: { type: 'object' }, description: '逐条命令结果：command/exitCode/timedOut/durationMs（run-metrics）。' },
    exitCodes: { type: 'array', items: {}, description: '每条命令的退出码（run-metrics）。' },
    metricsFile: { type: 'string', description: '指标文件相对路径（run-metrics）。' },
    timedOut: { type: 'boolean', description: '是否有命令/整体预算超时（run-metrics）。' },
    sandbox: { type: 'object', description: '沙箱模式：{network:"blocked-env",writes:"temp-copy-only"}。' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
})

const BATCH_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    targets: {
      type: 'array',
      items: { type: 'string' },
      description: `恰好 2–maxBatchTargets 个（默认最多 ${LIMITS.maxBatchTargets}，配置项 maxBatchTargets 可调低）互不相同的被评审项目路径；按顺序逐个评审。`,
    },
    title: { type: 'string', description: '展示名前缀（可选，会为每个 target 生成标题）。' },
    claims: { type: 'array', items: { type: 'string' }, description: '所有 target 共享的 claims（可选）。' },
    focus: { type: 'array', items: { type: 'string' }, description: '所有 target 共享的攻击面（可选）。' },
    outOfScope: { type: 'string', description: '不在本轮范围内的内容（可选）。' },
    environment: { type: 'string', description: '评审者可用环境说明（可选）。' },
    timeBudget: { type: 'string', description: '时间预算（可选）。' },
    profile: { type: 'string', enum: PROFILES, description: '领域 profile（可选；所有 target 共享）。' },
    mode: { type: 'string', enum: ROUND_MODES, description: '生命周期模式（fresh/reopen/incremental；默认 fresh）。' },
  },
  required: ['targets'],
})

const BATCH_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          target: { type: 'string' },
          ok: { type: 'boolean' },
          cycleId: { type: 'string' },
          round: { type: 'integer' },
          score: { type: 'number' },
          gate: { type: 'object' },
          error: { type: 'string' },
        },
      },
    },
    summary: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        passed: { type: 'integer' },
        failed: { type: 'integer' },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
})

function buildBatchDescription() {
  return `批量顺序评审（v1.3 3.4）：accepted 2–maxBatchTargets 个互不相同的 target，逐个调用与 ${TOOL_ROUND} 相同的「证据 → 红队 → 判官 → 门控」流程；每个 target 使用自己的 cycle/锁，某个 target 失败不会中断其余 target。本工具不接收 shots/evidence（每轮证据由 Host 自动探测或按默认策略渲染）。

返回 {ok, results:[{target,ok,cycleId,round,score,gate,error?}], summary:{total,passed,failed}}；passed 表示该 target 的 gate.passed=true。需要继续修复的 target 请用 ${TOOL_ROUND} 单独重跑（同一 target 自动续轮）。`
}

function buildRoundDescription() {
  return `对抗式评审一轮（红队评审台）：渲染 4 张证据代表图 → 独立红队子智能体挑刺（必须给证据）→ 另一个（judgeSamples 个）独立判官子智能体只依据红队报告独立打分（0–100，95 分通过；多判官取保守聚合）→ 返回门控结论。

何时调用：项目「做完/验收/交付/准备停」之前，或用户要求审查 AI 做的东西时。交付前必须至少调用一次，并持续调用直到返回 gate.passed === true。

行为：
- target 必填（被评审项目路径）。证据来源三选一：① 传恰好 4 张 evidence 证据卡（screenshot 静态图 / interaction 脚本化步骤 + 多帧 + console/network/perf / image 项目图表 PNG / pdf-text 论文 PDF 文本页）；② 传恰好 4 条旧 shots 截图规格；③ 都留空时自动探测 index.html/public/index.html/dist/index.html/src/index.html 并用 4 个视口渲染；都没有则渲染 4 张评审报告页。evidence 与 shots 互斥。
- 生命周期 mode（可选，默认 fresh）：target 的 cycle 已达 gate.passed 后，fresh 会被拒绝；用 mode:"reopen" 创建新 cycle 复评（轮数上限重置），或 mode:"incremental" 额外按上一通过轮的快照文件清单做「变更文件优先 + 未变更回归抽样」。
- 每轮固定产出 4 张代表图（evidence 每卡第一张图片），由本工具在 Host 侧用无头 Chrome / CDP 渲染；你不需要也不能自己截图，不要修改证据文件。
- 本轮返回紧凑 JSON：ok/cycleId/round/target/shots/evidence/profile/attack/score/gate/scoreStats/nextAction/message，以及审计字段 rubricVersion/promptHashes/modelRoute/judges。scoreStats 是各判官样本分的 mean/median/stdev/95%CI（v2.0，审计/校准用），门控仍取保守的 score.score。只有 gate.passed === true 才允许宣布完成或交付。
- v2.0 配置 judgeModels（≤3 个 {provider?,model?,reasoningEffort?}）可让每个判官样本使用不同模型；compact 的 modelRoute.samples 与 judges[].modelRoute 会记录每样本实际请求路由。
- 未通过时：按 score.mustFix 和 score.deductions[].fix 修复项目，然后再次调用本工具（同一 target，自动续到下一轮）。禁止跳过评审、禁止自行宣布「已达标」、禁止只修不评。
- 同一个 target 的 cycle 一旦 gate.passed=true 会被拒绝继续评审（防无限重复）。
- 失败返回 {ok:false, stage, error}，并会把该轮标记为 failed 保留可诊断信息；不要把失败当通过。`
}

function buildStatusDescription() {
  return `读取红队评审台的状态摘要（给 Agent 自检用，不用于 UI）：返回每个 cycle 的 target/status/required/轮数/最新一轮的评分、门控、mustFix 与失败原因。可选 target 过滤，limit 控制返回数量（默认 10）。`
}

function buildProbeDescription() {
  return `评审子智能体专用的只读探测工具（review_probe）：红队/判官没有 shell 与网络工具，只能通过本工具做只读检查。仅当前正在运行的评审子会话（Host 登记的 redteam/judge child）可调用，其他 Agent 调用会返回 {ok:false,error:'review_probe 仅限评审子智能体使用'}。

动作（全部只读且限制在被评审项目目录内）：
- list-files：只读遍历被评审项目（跳过 .git/node_modules 等），返回相对路径+大小；maxFiles 默认 200、上限 500。
- read-text：读取项目内单个文本文件（path 必填；默认 ≤200KB、上限 512KB），拒绝二进制/超限/越界路径。
- check-syntax：对项目内最多 100 个 .js/.mjs 文件逐个 node --check（并发≤4，总超时 60s），返回 checked 与 failures。
- run-tests：把项目复制到只读临时副本（排除 .git；超出预算时跳过 node_modules 并警告），在副本中执行 package.json 的 npm test（离线/禁代理环境），超时后终止进程树，输出尾部各 ≤4000 字符，结束后删除副本；项目没有 scripts.test 时返回错误，不猜测命令。
- run-metrics（v1.2 建模复现）：读取 target 根 ${MODELING_RUN_FILE}（{commands:[[argv...]], metricsFile?, timeoutSeconds?}），复制到只读临时副本，在副本 cwd 中**不经 shell** 逐条顺序执行 commands（离线 env、每命令超时默认 120s / 可配 modelingTimeoutSeconds、超时 kill 进程树），结束后从副本读取 metricsFile（JSON ≤64KB）返回 {commands,exitCodes,metrics,...}。没有 modeling-run.json 时明确报错，不猜测命令。

注意：run-tests/run-metrics 永远不会写被评审项目本身；只写临时副本并在结束后清理。`
}

/**
 * Plugin entry. `inject = ['tools']` guarantees the tools registry; every other
 * service is optional and resolved defensively.
 */
export function apply(ctx, config) {
  const log = createLogger(ctx)
  let effectiveConfig = DEFAULT_CONFIG
  try {
    effectiveConfig = buildEffectiveConfig(config)
  } catch (error) {
    // CONTRACT §2.14: invalid judgeModels must fail loudly, not silently fall
    // back to defaults (which would reset stateDir and could fail-open gates).
    log.warn('配置非法，插件拒绝加载（不会回退默认配置）', error)
    throw error
  }
  const cfg = effectiveConfig
  // v2.0: do not silently swallow relative goalGateRoots entries — dropped
  // scopes would widen the completion gate to every reviewed root.
  const rawGoalGateRoots = isPlainObject(config) && Array.isArray(config.goalGateRoots) ? config.goalGateRoots : []
  const droppedGoalGateRoots = rawGoalGateRoots.filter((entry) => (
    typeof entry === 'string' && entry.trim() !== '' && !path.isAbsolute(entry.trim())
  ))
  if (droppedGoalGateRoots.length > 0) {
    log.warn(`goalGateRoots 忽略了 ${droppedGoalGateRoots.length} 个非绝对路径条目（${droppedGoalGateRoots.map((entry) => String(entry)).join(', ')}）；只接受绝对路径，否则完成门禁会退化为“本会话全部交付根”。`)
  }
  if (cfg.enabled !== true) {
    log.info('已禁用（enabled=false），不注册任何工具/路由/提示词。')
    return
  }

  const getService = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  // 1. Build the store (eager load so the synchronous tool guard can read it).
  let store = null
  try {
    store = createStore({ stateDir: resolveStateDir(cfg, process.env) })
    store.init().catch((error) => log.warn('状态加载失败（将从空状态开始）', error))
  } catch (error) {
    log.warn('状态存储初始化失败，评审工具将返回明确错误', error)
  }

  const effectRegister = (label, factory) => {
    try {
      ctx.effect(() => {
        try {
          const disposer = factory()
          return typeof disposer === 'function' ? disposer : () => {}
        } catch (error) {
          log.warn(`${label}注册失败`, error)
          return () => {}
        }
      })
      return true
    } catch (error) {
      log.warn(`${label} effect 注册失败`, error)
      return false
    }
  }

  let routesInstalled = false
  let routeRetryLogged = false
  const ensureRoutes = () => {
    if (routesInstalled) return true
    const webServer = getService('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      if (!routeRetryLogged) {
        log.info('webServer 服务不可用：Web 面板暂时无法读取评审状态（工具仍可用）。')
        routeRetryLogged = true
      }
      return false
    }
    if (store === null) return false
    try {
      const handler = createHttpHandler({ store, stateDir: store.stateDir })
      if (effectRegister('HTTP 路由', () => webServer.register({ kind: 'prefix', path: HTTP_PREFIX, handler }))) {
        routesInstalled = true
        return true
      }
    } catch (error) {
      log.warn('HTTP 路由创建失败', error)
    }
    return false
  }

  let promptSectionInstalled = false
  const ensurePromptSection = () => {
    if (cfg.announceToAgent !== true) return false
    if (promptSectionInstalled) return true
    const systemPrompt = getService('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return false
    const installed = effectRegister('系统提示词', () => systemPrompt.section({
      name: 'adversarial-review',
      order: 900,
      text: SYSTEM_PROMPT_SECTION,
    }))
    if (installed) promptSectionInstalled = true
    return installed
  }

  // 2. Tools (the one hard dependency).
  const tools = (ctx && ctx.tools) || getService('tools')
  if (!tools || typeof tools.register !== 'function') {
    log.warn('tools 服务不可用，插件无法注册评审工具。')
    return
  }

  const roundTool = {
    name: TOOL_ROUND,
    description: buildRoundDescription(),
    parameters: ROUND_PARAMETERS,
    output: {
      schema: ROUND_OUTPUT_SCHEMA,
      render: textRender,
    },
    timeoutMs: ROUND_TIMEOUT_MS,
    async execute(args, exec) {
      try {
        ensureRoutes()
        ensurePromptSection()
        return await runReviewRound({
          config: cfg,
          store,
          args,
          agent: exec?.agent ?? null,
          subagents: getService('subagents'),
          workingDirectory: getService('workingDirectory'),
          signal: exec?.signal,
          now: Date.now,
        })
      } catch (error) {
        return { ok: false, stage: 'internal', error: error?.message || String(error) }
      }
    },
  }

  const statusTool = {
    name: TOOL_STATUS,
    description: buildStatusDescription(),
    parameters: STATUS_PARAMETERS,
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: textRender,
    },
    timeoutMs: STATUS_TIMEOUT_MS,
    async execute(args, exec) {
      try {
        // v2.0: review children must not read the full cross-project state.
        if (lookupReviewChild(exec?.agent?.id) !== null) {
          return { ok: false, stage: 'forbidden', error: '评审子智能体不得调用 adversarial_review_status（只能通过 review_probe 做只读检查）。' }
        }
        ensureRoutes()
        ensurePromptSection()
        const raw = isPlainObject(args) ? args : {}
        let target = ''
        if (raw.target !== undefined && raw.target !== null) {
          if (typeof raw.target !== 'string') {
            return { ok: false, stage: 'arguments', error: '参数 target 必须是字符串路径' }
          }
          target = raw.target.trim()
        }
        let limit = 10
        if (raw.limit !== undefined && raw.limit !== null) {
          const numeric = Number(raw.limit)
          if (!Number.isInteger(numeric) || numeric < 1 || numeric > LIMITS.maxCycles) {
            return { ok: false, stage: 'arguments', error: `参数 limit 必须是 1–${LIMITS.maxCycles} 的整数` }
          }
          limit = numeric
        }
        if (store === null) return { ok: false, stage: 'store', error: '状态存储不可用' }
        return await buildStatusSummary({ store, target, limit, now: Date.now })
      } catch (error) {
        return { ok: false, stage: 'internal', error: error?.message || String(error) }
      }
    },
  }

  // v1.3 3.4: sequential multi-target review. Each target runs the normal
  // round pipeline (own cycle + per-root lock); failures do not abort the batch.
  const batchTool = {
    name: TOOL_BATCH,
    description: buildBatchDescription(),
    parameters: BATCH_PARAMETERS,
    output: {
      schema: BATCH_OUTPUT_SCHEMA,
      render: textRender,
    },
    // v2.0: batch runs up to maxBatchTargets rounds sequentially, so its tool
    // timeout must scale with the configured target count (each target may take
    // the full single-round worst case).
    timeoutMs: ROUND_TIMEOUT_MS * Math.max(2, Number.isInteger(cfg.maxBatchTargets) ? cfg.maxBatchTargets : 10),
    async execute(args, exec) {
      try {
        ensureRoutes()
        ensurePromptSection()
        return await runReviewBatch({
          config: cfg,
          store,
          args,
          agent: exec?.agent ?? null,
          subagents: getService('subagents'),
          workingDirectory: getService('workingDirectory'),
          signal: exec?.signal,
          now: Date.now,
        })
      } catch (error) {
        return { ok: false, stage: 'internal', error: error?.message || String(error) }
      }
    },
  }

  // v1.1 1.5: Host-run read-only probe for review children. It is registered
  // globally (the tools registry is global) but `execute` rejects every caller
  // that is not a currently registered review subagent.
  const probeTool = {
    name: TOOL_PROBE,
    description: buildProbeDescription(),
    parameters: PROBE_PARAMETERS,
    output: {
      schema: PROBE_OUTPUT_SCHEMA,
      render: textRender,
    },
    timeoutMs: PROBE_TIMEOUT_MS,
    async execute(args, exec) {
      try {
        return await runReviewProbe({ args, execution: exec, config: cfg })
      } catch (error) {
        return { ok: false, stage: 'internal', error: error?.message || String(error) }
      }
    },
  }

  effectRegister(TOOL_ROUND, () => tools.register(roundTool))
  effectRegister(TOOL_STATUS, () => tools.register(statusTool))
  effectRegister(TOOL_BATCH, () => tools.register(batchTool))
  effectRegister(TOOL_PROBE, () => tools.register(probeTool))

  // 3. HTTP routes for the Web GUI panel.
  ensureRoutes()

  // 4. Global system-prompt section (skipped when announceToAgent=false).
  ensurePromptSection()

  // 5. Stop-gate tool guard: synchronous, side-effect free, never throws.
  //
  // v1.1 1.3/1.4 rewrite:
  // - `present` is now project-level: ANY cycle whose deliverable root contains
  //   a submitted file blocks delivery, regardless of session, fork or subagent.
  // - A passed round only allows delivery while the on-disk project still has
  //   the same snapshot manifestHash as the round that passed.
  // - `update_goal(complete)` keeps the per-session rule and additionally
  //   re-verifies the snapshot of the caller's passed rounds (no pass-then-edit).
  const snapshotLimits = () => ({
    maxFiles: cfg.snapshotMaxFiles,
    maxHashBytes: cfg.snapshotMaxHashBytes,
    maxFileBytes: cfg.snapshotMaxFileBytes,
  })

  /** realpath (native on Windows) with a lexical fallback for missing paths. */
  const realPathOf = (candidate) => {
    try {
      return typeof realpathSync.native === 'function' ? realpathSync.native(candidate) : realpathSync(candidate)
    } catch {
      return candidate
    }
  }

  /**
   * v2.0: resolve the newest cycle per distinct deliverable root covering a
   * presented path. A file may be covered by nested/overlapping delivery roots;
   * EVERY covering root is checked (any unpassed root rejects), matching the
   * fail-closed contract. realpath normalization defeats Win32 aliases; a
   * lexical match whose real path escapes the root is kept so the snapshot
   * guard can reject it.
   */
  const presentGateCycles = (state, candidate) => {
    const candidateReal = realPathOf(candidate)
    // rootReal -> Set of lexical roots (realpath aliases may map to the same
    // directory; EVERY lexical spelling must still be looked up, otherwise a
    // junction/short-name delivery root could be silently skipped).
    const roots = new Map()
    for (const cycle of listCycles(state)) {
      const root = cycleDeliverableRoot(cycle)
      if (root === '') continue
      const rootReal = realPathOf(root)
      const matches = isPathInsideOrEqual(rootReal, candidateReal) || isPathInsideOrEqual(root, candidate)
      if (!matches) continue
      let aliasSet = roots.get(rootReal)
      if (aliasSet === undefined) {
        aliasSet = new Set()
        roots.set(rootReal, aliasSet)
      }
      aliasSet.add(root)
    }
    const result = []
    for (const aliasSet of roots.values()) {
      for (const root of aliasSet) {
        const cycle = newestCycleByDeliverableRoot(state, root)
        if (cycle !== null) result.push(cycle)
      }
    }
    return result
  }

  const buildBlockReason = (cycle, round, attemptedAction) => {
    const title = typeof cycle.title === 'string' && cycle.title !== '' ? cycle.title : cycle.target
    const parts = []
    if (round === null) {
      parts.push('尚无评审轮次')
    } else if (round.status === 'failed') {
      parts.push(`第 ${round.n} 轮失败：${typeof round.error === 'string' ? truncateText(round.error, 300) : '未知错误'}`)
    } else if (isPlainObject(round.gate)) {
      const requiredScore = Number.isFinite(round.gate.requiredScore) ? round.gate.requiredScore : cfg.requiredScore
      const requiredShots = Number.isInteger(round.gate.requiredShots) ? round.gate.requiredShots : cfg.requiredShots
      const score = typeof round.gate.score === 'number' ? round.gate.score : '—'
      const findings = Number.isInteger(round.gate.findings) ? round.gate.findings : 0
      const shots = Number.isInteger(round.gate.shots) ? round.gate.shots : 0
      parts.push(`总分 ${score}/${requiredScore}，有效发现 ${findings} 条，截图 ${shots}/${requiredShots}`)
      if (Array.isArray(round.gate.failReasons) && round.gate.failReasons.length > 0) {
        parts.push(round.gate.failReasons.slice(0, 3).join('；'))
      }
    } else {
      parts.push('最新轮次尚未完成')
    }
    return `【红队评审台】评审目标「${title}」尚未通过门控，禁止${attemptedAction}。${parts.join('；')}。请按判官 mustFix 与扣分项修复后再次调用 ${TOOL_ROUND}；只有 gate.passed=true 才允许停止/交付。`
  }

  const buildSnapshotMismatchReason = (cycle, round, attemptedAction, detail = '') => {
    const title = typeof cycle.title === 'string' && cycle.title !== '' ? cycle.title : cycle.target
    const score = isPlainObject(round?.gate) && typeof round.gate.score === 'number' ? round.gate.score : '—'
    const suffix = detail === '' ? '' : `（${detail}）`
    return `【红队评审台】评审目标「${title}」在通过轮次（第 ${round?.n ?? '—'} 轮，${score}/100）之后项目文件已变更${suffix}：评审快照哈希不一致，禁止${attemptedAction}。请修复后重新评审；已通过的 cycle 可用 mode:"reopen"/"incremental" 创建新 cycle 复评。`
  }

  /** Verify a passed round's snapshot against the current tree; null = OK. */
  const verifyPassedSnapshot = (cycle, passedRound, attemptedAction, submittedFiles = []) => {
    const record = isPlainObject(passedRound?.snapshot) ? passedRound.snapshot : null
    // v2.0 (fail-closed): a passed round without a snapshot/file list cannot
    // prove that the delivered tree is unchanged, so completion and delivery
    // both require a re-review (reopen/incremental) for legacy rounds.
    if (record === null || typeof record.manifestHash !== 'string' || record.manifestHash === '') {
      return buildSnapshotMismatchReason(
        cycle,
        passedRound,
        attemptedAction,
        '该通过轮没有项目快照/文件清单（legacy），无法证明交付内容未被修改；请用 mode:"reopen"/"incremental" 重新评审后再交付',
      )
    }
    const root = cycleDeliverableRoot(cycle)
    if (root === '') return null
    let current = null
    try {
      current = computeSnapshotSync(root, { limits: snapshotLimits() })
    } catch (error) {
      return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction, `快照重算异常 ${error?.message || error}`)
    }
    if (!isPlainObject(current) || current.ok === false) {
      const message = isPlainObject(current?.error) ? (current.error.message || '未知错误') : '未知错误'
      return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction, `快照重算失败：${message}`)
    }
    // v2.0 (fail-closed): a snapshot that did not hash every deliverable file
    // cannot prove content integrity (same-size rewrite + restored mtime would
    // bypass a metadata-only entry). Refuse delivery until limits are raised and
    // the project is re-reviewed.
    const currentUnhashed = current.truncated === true || Number(current.skippedCount) > 0
    const recordUnhashed = record.truncated === true || Number(record.skippedCount) > 0
    if (currentUnhashed || recordUnhashed) {
      return buildSnapshotMismatchReason(
        cycle,
        passedRound,
        attemptedAction,
        '项目快照包含未哈希文件（超过 maxFileBytes/maxHashBytes 预算），无法证明交付内容未变更；请提高 snapshotMaxFileBytes/snapshotMaxHashBytes 后重新评审',
      )
    }
    if (current.manifestHash !== record.manifestHash) return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction)

    // v2.0 (fail-closed): every passed round must carry its hashed file list.
    // Without it neither present (membership) nor update_goal (project-level
    // change detection) can be proven, so delivery/stop is refused.
    const filesFile = typeof record.filesFile === 'string' ? record.filesFile.trim() : ''
    if (filesFile === '') {
      return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction, '通过轮快照缺少文件清单（filesFile），无法证明交付内容未变更；请重新评审')
    }
    if (Array.isArray(submittedFiles) && submittedFiles.length > 0) {
      let baseline = null
      try {
        const stateDir = store === null ? '' : store.stateDir
        baseline = JSON.parse(readFileSync(path.join(stateDir, filesFile), 'utf8'))
      } catch (error) {
        return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction, `无法读取通过轮快照文件清单：${error?.message || error}`)
      }
      const entries = Array.isArray(baseline?.files) ? baseline.files : []
      const hashed = new Map()
      for (const entry of entries) {
        if (!isPlainObject(entry) || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') continue
        hashed.set(entry.path.replace(/\\/g, '/').toLowerCase(), entry.sha256)
      }
      for (const submitted of submittedFiles) {
        let relative = ''
        try {
          relative = path.relative(root, submitted)
        } catch {
          relative = ''
        }
        const normalized = relative.replace(/\\/g, '/').toLowerCase()
        if (normalized === '' || normalized.startsWith('..') || path.isAbsolute(relative)) {
          return buildSnapshotMismatchReason(cycle, passedRound, attemptedAction, `提交文件「${submitted}」不在交付根内`)
        }
        if (!hashed.has(normalized)) {
          return buildSnapshotMismatchReason(
            cycle,
            passedRound,
            attemptedAction,
            `提交文件「${relative}」不在通过轮快照的已哈希清单中（新增文件，或位于 node_modules 等未纳入快照的依赖目录），无法证明未变更；请重新评审`,
          )
        }
      }
    }
    return null
  }

  const guard = (execution) => {
    let toolName = ''
    let isComplete = false
    let isPresent = false
    let reviewerActive = false
    try {
      const agent = execution && execution.agent
      const agentId = typeof agent?.id === 'string' ? agent.id : ''
      toolName = typeof execution?.name === 'string' ? execution.name : ''
      const args = isPlainObject(execution?.arguments) ? execution.arguments : {}

      // v1.1 1.5 (B-08/B-13/B-14/B-10): a registered review child (red team /
      // judge) is hard read-only. Dangerous tools are denied outright and every
      // filesystem read must stay inside the reviewed targetDir; `review_probe`
      // remains available for read-only checks run by the Host.
      // The enhancement can be disabled for debugging with `readOnlyReviewers`.
      if (cfg.readOnlyReviewers === true && agentId !== '') {
        const reviewer = lookupReviewChild(agentId)
        if (reviewer !== null) {
          reviewerActive = true
          const denied = evaluateReviewerAccess(reviewer, toolName, args)
          if (denied !== null) return denied
        }
      }

      const snapshot = store === null ? null : store.peek()
      if (snapshot === null) {
        // v2.0 (fail-closed): during the first async state load, gate tools must
        // NOT wave through present/update_goal. Unrelated tools stay unaffected.
        if (toolName === 'present' || (toolName === 'update_goal' && args.action === 'complete')) {
          return '【红队评审台】评审状态尚未加载完成，无法校验门控；为防止绕过，已拒绝本次交付/完成操作。请稍后重试。'
        }
        return undefined
      }

      if (cfg.enforceGoalGate === true && toolName === 'update_goal' && args.action === 'complete') {
        isComplete = true
        // Without a session we keep the old behaviour (do not block unrelated
        // sessions); the present guard below is session-independent instead.
        if (agentId === '') return undefined
        // v1.3 3.2: evaluate the NEWEST cycle per deliverable root. A stale
        // older reviewing/passed cycle must not block (or authorise) completion
        // of a project whose latest review is passed/failed respectively.
        const roots = new Set()
        for (const cycle of listCycles(snapshot)) {
          if (cycle.sessionId !== agentId) continue
          const root = cycleDeliverableRoot(cycle)
          if (root !== '') roots.add(root)
        }
        // v2.0: optional scope. Calibration fixtures and demo projects that are
        // intentionally defective must not block completion of the session's own
        // goal; only roots listed in goalGateRoots are enforced. Empty = all.
        // Both the configured scope and the cycle root are realpath-normalized so
        // junction / 8.3 / alias spellings cannot silently skip the gate.
        const gateRoots = Array.isArray(cfg.goalGateRoots)
          ? cfg.goalGateRoots
            .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
            .map((entry) => realPathOf(path.resolve(entry.trim())))
          : []
        // v2.0: goal completion is SESSION-scoped (CONTRACT §guard): pick the
        // newest cycle of THIS session per root, not a cycle another session
        // wrote for the same deliverable root.
        const sessionNewest = new Map()
        for (const cycle of listCycles(snapshot)) {
          if (cycle.sessionId !== agentId) continue
          const cycleRoot = cycleDeliverableRoot(cycle)
          if (cycleRoot === '') continue
          const key = targetKey(cycleRoot)
          const previous = sessionNewest.get(key)
          if (previous === undefined || (cycle.updatedAt || 0) > (previous.updatedAt || 0)) {
            sessionNewest.set(key, cycle)
          }
        }
        for (const root of roots) {
          const rootReal = realPathOf(root)
          // v2.0: exact delivery-root match only — nested targets (e.g. a
          // benchmark fixture under the plugin directory) are separate roots and
          // must not inherit the parent's gate scope.
          const matchesScope = gateRoots.length > 0
            && gateRoots.some((scopeRoot) => (
              isPathInsideOrEqual(scopeRoot, rootReal) && isPathInsideOrEqual(rootReal, scopeRoot)
            ))
          if (gateRoots.length > 0 && !matchesScope) continue
          const newest = sessionNewest.get(targetKey(root)) ?? null
          if (newest === null) continue
          const round = latestRoundOf(newest)
          const passed = round !== null && isPlainObject(round.gate) && round.gate.passed === true
          if (!passed) return buildBlockReason(newest, round, '把目标标记为完成')
          const blocked = verifyPassedSnapshot(newest, round, '把目标标记为完成')
          if (blocked !== null) return blocked
        }
        // Scope semantics (CONTRACT §guard): goalGateRoots only gates the
        // delivery roots it lists. A session whose reviewed roots are all
        // out-of-scope (calibration fixtures, demos, unrelated projects) is not
        // gated by this scope and may complete normally.
        return undefined
      }

      if (cfg.enforceGateOnPresent === true && toolName === 'present') {
        isPresent = true
        const files = Array.isArray(args.files) ? args.files : []
        for (const file of files) {
          const rawPath = typeof file?.path === 'string' ? file.path.trim() : ''
          if (rawPath === '') continue
          const candidates = []
          if (path.isAbsolute(rawPath)) {
            candidates.push(path.resolve(rawPath))
          } else {
            // A relative present path is resolved against each known root, so
            // both absolute and relative submissions are gate-checked.
            for (const cycle of listCycles(snapshot)) {
              const root = cycleDeliverableRoot(cycle)
              if (root === '') continue
              try {
                candidates.push(path.resolve(root, rawPath))
              } catch {
                // Ignore unusable roots; the remaining candidates still apply.
              }
            }
          }
          const checked = new Set()
          for (const candidate of candidates) {
            // v2.0: evaluate EVERY distinct delivery root covering this file
            // (newest cycle per root); any unpassed root rejects. This closes
            // the nested/overlapping deliverableRoots fail-open boundary.
            for (const cycle of presentGateCycles(snapshot, candidate)) {
              if (checked.has(cycle.id)) continue
              checked.add(cycle.id)
              const round = latestRoundOf(cycle)
              const passed = round !== null && isPlainObject(round.gate) && round.gate.passed === true
              if (!passed) return buildBlockReason(cycle, round, '交付评审目标内的文件')
              const blocked = verifyPassedSnapshot(cycle, round, '交付评审目标内的文件', [candidate])
              if (blocked !== null) return blocked
            }
          }
        }
        return undefined
      }
    } catch (error) {
      // Fail closed: a guard failure must never silently allow completion or
      // delivery of a reviewed project, nor widen a reviewer's tool surface.
      const detail = error?.message || String(error)
      if (reviewerActive) return `【红队评审台】评审者工具守卫校验异常（${truncateText(detail, 200)}）；为防止越权，已拒绝本次工具调用。`
      if (isComplete) return `【红队评审台】门控校验异常（${truncateText(detail, 200)}）；为防止绕过，已拒绝把目标标记为完成。`
      if (isPresent) return `【红队评审台】门控校验异常（${truncateText(detail, 200)}）；为防止绕过，已拒绝本次交付。`
      return undefined
    }
    return undefined
  }

  try {
    if (typeof tools.guard === 'function') {
      effectRegister('门控 guard', () => tools.guard(guard))
    } else {
      log.warn('tools.guard 不可用：无法强制「未达标不得停止」的门控。')
    }
  } catch (error) {
    log.warn('门控 guard 注册失败', error)
  }
}
