/**
 * Lead-owned constants: default config, tool names, shared JSON schemas and limits.
 * No imports, no side effects — safe to import from tests and from both host modules.
 */

export const STATE_SCHEMA_VERSION = 3
export const HTTP_PREFIX = '/adversarial-review'

/** Rubric generation stamped on every new round (100-point scale, pass 95). */
export const RUBRIC_VERSION = 'v2-100'
/**
 * v2.0 published scoring-rubric identifier. `RUBRIC_VERSION` is the machine
 * rubric revision stamped on every round; this is the human-facing publication
 * version used by the calibration report and docs/SCORING-RUBRIC.md.
 */
export const SCORING_RUBRIC_VERSION = '2026-10-v2'
/** Rubric generation of migrated 10-point rounds (kept for history tooling). */
export const LEGACY_RUBRIC_VERSION = 'legacy-10'

export const TOOL_ROUND = 'adversarial_review_round'
export const TOOL_STATUS = 'adversarial_review_status'
/** v1.1 1.5: Host-run read-only probe for review children (they have no shell). */
export const TOOL_PROBE = 'review_probe'
/** v1.3 3.4: sequential multi-target review (2–maxBatchTargets targets). */
export const TOOL_BATCH = 'adversarial_review_batch'

// ---------------------------------------------------------------------------
// v1.3 3.2/3.3: cycle lifecycle, incremental review and progress
// ---------------------------------------------------------------------------

/** v1.3 3.2: per-call cycle mode. `fresh` keeps the pre-v1.3 behaviour. */
export const ROUND_MODES = Object.freeze(['fresh', 'reopen', 'incremental'])

/** v1.3 3.3: progress stages persisted on `round.progress`. */
export const PROGRESS_STAGES = Object.freeze(['evidence', 'attacker', 'judge', 'gate', 'done', 'cancelled'])

/** v1.3 3.1: finding status values used by the diff endpoint / known-findings list. */
export const FINDING_DIFF_STATUSES = Object.freeze(['new', 'repeat', 'fixed', 'severity-changed'])

// ---------------------------------------------------------------------------
// v1.2 2.1/2.3a: evidence framework + domain profiles
// ---------------------------------------------------------------------------

/** v1.2 2.3a: domain profile selecting the injected rubric. `code` is the default. */
export const PROFILES = Object.freeze(['code', 'web', 'game', 'modeling'])

/** Host-trusted rubric files (`rubrics/`) injected per profile; absent = no rubric text. */
export const PROFILE_RUBRICS = Object.freeze({
  game: 'rubrics/game.md',
  modeling: 'rubrics/modeling.md',
})

/**
 * v1.2 2.1/2.3b: evidence card kinds.
 * - screenshot  static browser page (existing shots path)
 * - interaction scripted CDP playthrough (existing CDP runner)
 * - image       project-local PNG artifact copied into the evidence dir
 * - pdf-text    zero-dependency PDF text extraction rendered as a text page PNG
 */
export const EVIDENCE_KINDS = Object.freeze(['screenshot', 'interaction', 'image', 'pdf-text'])

/** Scripted interaction actions the zero-dependency CDP runner understands. */
export const EVIDENCE_ACTIONS = Object.freeze(['goto', 'wait', 'click', 'key', 'screenshot'])

/** Default viewport of one evidence card (override per card with width/height). */
export const EVIDENCE_DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 })

/** Default viewport of a rendered PDF text page (portrait, override per card). */
export const PDF_TEXT_DEFAULT_VIEWPORT = Object.freeze({ width: 1200, height: 1600 })

/**
 * v1.2 2.4: the one file a modeling project may declare to let reviewers
 * reproduce its metrics inside a throwaway read-only copy (`review_probe`
 * action `run-metrics`).
 */
export const MODELING_RUN_FILE = 'modeling-run.json'

/** Default metrics file name read from the temp copy after commands run. */
export const MODELING_DEFAULT_METRICS_FILE = 'metrics.json'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  requiredScore: 95,
  requiredFindings: 3,
  requiredShots: 4,
  maxRounds: 12,
  roundTimeoutSeconds: 900,
  childProvider: 'spawn',
  attackerPreset: 'redteam-review',
  judgePreset: 'review-judge',
  // Number of independent judge sessions per round (1–MAX_JUDGE_SAMPLES).
  // 2 is the v1.1 default: scores are aggregated conservatively (lower median).
  judgeSamples: 2,
  // Optional child model routing. Empty means "inherit the parent route" and
  // is the only mode that works with providers lacking `agentOptions`.
  attackerProvider: '',
  attackerModel: '',
  attackerReasoningEffort: '',
  judgeProvider: '',
  judgeModel: '',
  judgeReasoningEffort: '',
  // v2.0 Stage A: optional per-sample judge model routes. Each entry is
  // `{provider?, model?, reasoningEffort?}` and overrides the default judge
  // route for judge sample i. Empty = every sample inherits the default route.
  // Validated strictly by buildEffectiveConfig (at most LIMITS.maxJudgeModels).
  judgeModels: Object.freeze([]),
  // v2.0 Stage A: drift thresholds used by benchmarks/drift.mjs.
  // Negative deltas beyond these trigger a regression alert.
  driftScoreDelta: 5,
  driftRecallDelta: 0.1,
  driftPassRateDelta: 0.1,
  // v1.2 2.3a: domain profile (`code` | `web` | `game` | `modeling`). `game`
  // injects `rubrics/game.md` into both review prompts; `code`/`web` keep the
  // pre-v1.2 behaviour (`web` only adds one evidence-coverage sentence).
  profile: 'code',
  // v1.2 2.2: hard budget for ONE interaction evidence card (spawn → steps →
  // screenshots → teardown). The browser is killed and temp dirs removed on
  // expiry; the round fails at stage `screenshots` instead of hanging.
  interactionTimeoutSeconds: 60,
  // v1.2 2.4: per-command timeout for `review_probe run-metrics` (sandbox copy,
  // offline env, kill process tree on expiry). 1–600 seconds.
  modelingTimeoutSeconds: 120,
  chromePath: '',
  stateDir: '',
  announceToAgent: true,
  enforceGoalGate: true,
  enforceGateOnPresent: true,
  // v2.0: restrict the update_goal(complete) gate to these delivery roots.
  // Empty = every root the session reviewed (legacy behaviour). Calibration
  // fixtures / demos that intentionally fail must not permanently block the
  // session's own goal, so deployments may list only the real deliverables.
  goalGateRoots: Object.freeze([]),
  screenshotTimeoutSeconds: 90,
  // v1.1 1.3: delivery roots a review target must live in. Empty = the target
  // itself is its delivery root. Declared roots block "review a sub-directory
  // and deliver it" and bind every file under the root to the gate.
  deliverableRoots: Object.freeze([]),
  // v1.1 1.4: extra exact origins allowed for http(s) screenshot specs
  // (loopback hosts 127.0.0.1 / ::1 / localhost are always allowed).
  allowedOrigins: Object.freeze([]),
  // v1.1 1.3 / v2.0: snapshot bounds (files hashed / total bytes hashed / max file).
  snapshotMaxFiles: 20000,
  snapshotMaxHashBytes: 512 * 1024 * 1024,
  snapshotMaxFileBytes: 64 * 1024 * 1024,
  // v1.1 1.5: reviewers are hard read-only. When true, the tool guard denies
  // dangerous tools to registered review children and confines their
  // filesystem reads to the reviewed target; `review_probe` executes their
  // read-only checks inside the Host process (run-tests runs in a temp copy).
  // The flag exists only for debugging: presets never grant shell/web tools.
  readOnlyReviewers: true,
  // v1.1 1.5: `review_probe` bounds. run-tests copies the target to a temp dir
  // (excluding .git; node_modules is skipped when the copy budget is exceeded)
  // and is killed after probeTimeoutSeconds.
  probeTimeoutSeconds: 120,
  probeMaxCopyBytes: 100 * 1024 * 1024,
  probeMaxCopyFiles: 20000,
  // v1.3 3.2: incremental review bounds. Changed/added/removed file lists are
  // capped to this many entries (truncated flag); `incrementalFullReview=true`
  // forces a full review while still recording the diff for audit.
  incrementalMaxChangedFiles: 200,
  incrementalFullReview: false,
  // v1.3 3.4: sequential batch review tool accepts 2..maxBatchTargets targets.
  maxBatchTargets: 10,
})

/** Hard limits that keep one round bounded and make hostile output harmless. */
export const LIMITS = Object.freeze({
  maxFindings: 40,
  maxDeductions: 20,
  maxMustFix: 20,
  maxTextChars: 6000,
  maxShots: 12,
  maxCycles: 30,
  maxRoundsPerCycle: 40,
  maxStateBytes: 8 * 1024 * 1024,
  /** `judgeSamples` never exceeds this: N judges cost N× judge latency. */
  maxJudgeSamples: 3,
  /** v2.0: `judgeModels` never exceeds this (config rejects longer lists). */
  maxJudgeModels: 3,
  /** v2.0: calibration/drift statistics bounds. */
  maxCalibrationFixtures: 100,
  maxDriftAlerts: 200,
  maxDriftFixtures: 200,
  // v1.1 1.5: review_probe bounds.
  probeDefaultListFiles: 200,
  probeMaxListFiles: 500,
  probeDefaultReadBytes: 200 * 1024,
  probeMaxReadBytes: 512 * 1024,
  probeMaxSyntaxFiles: 100,
  probeSyntaxConcurrency: 4,
  probeSyntaxTimeoutMs: 60_000,
  probeOutputTailChars: 4000,
  /** Upper bound for one `review_probe` spawn; the tool timeout stays above it. */
  probeMaxTimeoutSeconds: 600,
  // v1.2 2.1/2.2: evidence framework bounds. Four cards, each with at least one
  // image; total artifacts (representative + extra frames) per round.
  maxEvidenceArtifacts: 24,
  maxEvidenceStepsPerCard: 20,
  maxEvidenceCards: 8,
  /** Console/network collectors stop after this many entries (truncated flag). */
  maxEvidenceConsoleEvents: 60,
  maxEvidenceNetworkEvents: 100,
  maxEvidenceFailureSamples: 8,
  /** One persisted console/network line / step name is truncated to this. */
  evidenceEventChars: 200,
  // v1.2 2.3b: zero-dependency PDF text extraction limits.
  pdfMaxPages: 50,
  pdfMaxTextBytes: 200 * 1024,
  /** A project-local `image` evidence artifact larger than this is rejected. */
  evidenceImageMaxBytes: 20 * 1024 * 1024,
  // v1.2 2.4: `review_probe run-metrics` sandbox bounds.
  modelingMaxCommands: 20,
  modelingMaxArgs: 64,
  modelingMaxArgChars: 2000,
  modelingRunFileMaxBytes: 256 * 1024,
  modelingMetricsMaxBytes: 64 * 1024,
  /** Whole run-metrics wall-clock budget (outer probe tool timeout is 900s). */
  modelingMaxTotalSeconds: 600,
  // v1.3 3.4: batch tool hard cap (config maxBatchTargets is clamped to this).
  maxBatchTargets: 10,
  // v1.3 3.1/3.3: bounded projections for noise/diff/export public state.
  maxNoiseSuppressed: 20,
  maxKnownFindings: 20,
  maxDiffChanges: 300,
  maxIncrementalFilesStored: 1000,
})

export const SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR'])
export const ATTACK_VERDICTS = Object.freeze(['BLOCK', 'HOLD', 'PASS'])
export const SCORE_VERDICTS = Object.freeze(['PASS', 'HOLD', 'BLOCK'])
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low'])

/** Structured output contract handed to the red-team child. */
export const ATTACK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings', 'solid', 'unverified'],
  properties: {
    verdict: { type: 'string', enum: ['BLOCK', 'HOLD', 'PASS'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'evidence', 'attack', 'impact', 'fix', 'confidence', 'verified'],
        properties: {
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR'] },
          title: { type: 'string' },
          evidence: { type: 'string' },
          attack: { type: 'string' },
          impact: { type: 'string' },
          fix: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          verified: { type: 'boolean' },
        },
      },
    },
    solid: { type: 'array', items: { type: 'string' } },
    unverified: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'needs'],
        properties: { item: { type: 'string' }, needs: { type: 'string' } },
      },
    },
    nextSteps: { type: 'string' },
  },
})

/** Structured output contract handed to the scoring child. */
export const SCORE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'score',
    'verdict',
    'findingsCount',
    'validFindings',
    'deductions',
    'mustFix',
    'screenshots',
    'nextAction',
    'rationale',
  ],
  properties: {
    score: { type: 'number' },
    verdict: { type: 'string', enum: ['PASS', 'HOLD', 'BLOCK'] },
    findingsCount: { type: 'integer' },
    validFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'supported'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR'] },
          supported: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    // v2.0: supported blockers may also be reported in a dedicated list; they
    // are merged into validFindings (supported:true) by validateScore.
    blockingFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['BLOCKER', 'MAJOR', 'MINOR'] },
          supported: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    deductions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['points', 'reason', 'fix'],
        properties: {
          points: { type: 'number' },
          reason: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    mustFix: { type: 'array', items: { type: 'string' } },
    screenshots: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'quality', 'note'],
      properties: {
        count: { type: 'integer' },
        quality: { type: 'string', enum: ['good', 'partial', 'bad'] },
        note: { type: 'string' },
      },
    },
    nextAction: { type: 'string', enum: ['stop', 'fix_and_review'] },
    rationale: { type: 'string' },
  },
})

/** One screenshot spec: exactly one of path/url (validated in shots.js). */
export const DEFAULT_SHOT_VIEWPORTS = Object.freeze([
  { width: 1440, height: 900, name: 'desktop' },
  { width: 1280, height: 800, name: 'laptop' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 390, height: 844, name: 'mobile' },
])
