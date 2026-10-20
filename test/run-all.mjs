/**
 * In-process test entry point for sandboxed shells.
 *
 * The canonical command from the workspace root is:
 *
 *   node --test redteam-console/test/
 *
 * That form makes Node's test runner spawn one child process per test file, and
 * a confined DSH shell denies piped child processes (`spawn EPERM`). Importing
 * the files in one process runs the exact same tests without spawning:
 *
 *   node redteam-console/test/run-all.mjs
 *
 * This file is not a `*.test.mjs` file, so the canonical runner ignores it.
 */

import './rubric.test.mjs'
import './snapshot.test.mjs'
import './redact.test.mjs'
import './store.test.mjs'
import './shots.test.mjs'
import './report.test.mjs'
import './presets.test.mjs'
import './probe.test.mjs'
import './injection.test.mjs'
import './benchmarks.test.mjs'
import './stats.test.mjs'
import './drift.test.mjs'
import './calibrate.test.mjs'
import './noise.test.mjs'
import './pdf.test.mjs'
import './sandbox.test.mjs'
import './evidence.test.mjs'
import './cdp.test.mjs'
import './orchestrate.test.mjs'
import './routes.test.mjs'
import './index.test.mjs'
import './client-logic.test.mjs'
