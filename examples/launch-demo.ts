/**
 * Launch-brief demo for recording (see docs/LAUNCH-DEMO.md): two independent
 * Mastra agent invocations on one Superserve VM, with a scripted pause and a
 * reconnect by `sandboxId` in between (examples/launch-task.ts).
 *
 * Environment (read from .env by the npm script via --env-file-if-exists):
 * - SUPERSERVE_API_KEY, OPENAI_API_KEY: required.
 * - OPENAI_MODEL: default `gpt-5.4-mini`.
 * - LAUNCH_S1_MAX_STEPS / LAUNCH_S2_MAX_STEPS: step budgets, 1–40, default 38 / 30.
 * - DEMO_SETUP_EDITOR=1: install Mousepad first if the VM has no GUI editor.
 * - DEMO_VIEWER=1: serve http://localhost:7777/ (DEMO_VIEWER_PORT), which
 *   redirects to a fresh private, view-only desktop viewer. Waits up to 2 min
 *   for it before Session 1, and up to 1 min for a reload before Session 2.
 * - LAUNCH_EDITOR_LOOK=0: skip the best-effort display settings (Mousepad
 *   font Monospace 16, maximized window, no desktop icons).
 *
 * The earlier demo (`DEMO_MODE=1 DEMO_CONTINUE=1 pnpm example:agent`) is
 * unchanged and remains the fallback. Steps and wall time are capped, and the
 * VM is always destroyed and its deletion confirmed. Keys and viewer URLs are
 * never printed.
 *
 *   pnpm example:launch
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Workspace } from '@mastra/core/workspace';
import type { SuperserveSandbox } from '../src/index.js';
import { destroyAndConfirm, mintViewerUrl, shortId, startViewerRedirect, type ViewerRedirect, waitForViewer } from './demo.js';
import { createDesktopWorkspace } from './desktop-agent.js';
import {
  describeError,
  EDITOR_SETUP_TIMEOUT_SECONDS,
  installMousepad,
  preflightEditorTask,
  retryReadOnlyOnce,
} from './editor-task.js';
import {
  banner,
  LAUNCH_DOC_PATH,
  LAUNCH_TOOLS,
  type LaunchConfig,
  launchConfig,
  pickBudget,
  prepareEditorLook,
  runLaunchDemo,
} from './launch-task.js';

let config: LaunchConfig;
try {
  config = launchConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const missing = ['SUPERSERVE_API_KEY', 'OPENAI_API_KEY'].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.log(`Skipping: set ${missing.join(' and ')} (see .env.example) to run this example.`);
  process.exit(0);
}

/**
 * Wall-time cap per agent run. Session 1 worst case: 38 steps at ~8 s of
 * model time each (screenshots in context) plus ~40 s of tool time. Only a
 * cap: model calls are bounded by the step budgets.
 */
const SESSION_TIMEOUT_MS = 6 * 60_000;
const VIEWER_WAIT_MS = 2 * 60_000;
const VIEWER_RELOAD_WAIT_MS = 60_000;
/**
 * Auto-pause safety net (a leak backstop; cleanup destroys the VM anyway).
 * The provider default, 900 s, unless the longest active stretch before the
 * scripted pause needs more: VM start, the optional Mousepad install and
 * viewer wait, Session 1 and its checks, plus a minute.
 */
const VM_TIMEOUT_SECONDS = Math.max(
  900,
  60 +
    (config.setupEditor ? EDITOR_SETUP_TIMEOUT_SECONDS + 60 : 0) +
    (config.viewer ? VIEWER_WAIT_MS / 1000 + 5 : 0) +
    SESSION_TIMEOUT_MS / 1000 +
    120,
);
const SANDBOX_OPTIONS = { namePrefix: 'mastra-launch-demo', timeoutSeconds: VM_TIMEOUT_SECONDS };
/** Two agent runs, VM start + lifecycle, cleanup, and the optional setup and viewer waits. */
const WATCHDOG_MS =
  2 * SESSION_TIMEOUT_MS +
  3 * 60_000 +
  2 * 60_000 +
  (config.setupEditor ? (EDITOR_SETUP_TIMEOUT_SECONDS + 60) * 1000 : 0) +
  (config.viewer ? VIEWER_WAIT_MS + VIEWER_RELOAD_WAIT_MS + 30_000 : 0);

const target = LAUNCH_DOC_PATH;
const { sandbox, workspace } = createDesktopWorkspace(SANDBOX_OPTIONS, LAUNCH_TOOLS);
let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
let viewer: ViewerRedirect | undefined;
let ok = false;
/** The scripted step in progress, named in the FAIL line. */
let phase = 'start';

let destroyed: Promise<void> | undefined;
const destroy = () =>
  (destroyed ??= (async () => {
    await viewer?.close();
    if (sandbox.status === 'pending') {
      console.log('cleanup: no VM was created');
      return;
    }
    const vmId = restored?.sandbox.sandboxId ?? sandbox.sandboxId;
    try {
      if (!vmId) throw new Error('no sandbox id to confirm deletion');
      // Newest instance first; destroying the stale original afterwards is a no-op.
      const status = await destroyAndConfirm([...(restored ? [restored.workspace] : []), workspace], vmId, sandbox.id);
      if (status !== 'deleted' && status !== 'absent') throw new Error(`VM still ${status} after destroy`);
      console.log(`[VM] Destroyed (sandbox ${shortId(vmId)} no longer listed by Superserve)`);
    } catch (error) {
      process.exitCode = 1;
      ok = false;
      console.error(`cleanup FAILED: ${describeError(error)}`);
      console.error(
        `  Delete Superserve VM ${String(vmId ?? '(unknown id)')} manually. ` +
          `Otherwise it auto-pauses after ${VM_TIMEOUT_SECONDS}s active and is auto-deleted 600s after pausing.`,
      );
    }
  })());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    console.error(`\n${signal} received, cleaning up...`);
    void destroy().finally(() => process.exit(130));
  });
}
// If the event loop drains while the run is still awaiting something, destroy the VM first.
process.once('beforeExit', () => {
  if (!destroyed) {
    console.error('Event loop drained before the run finished; cleaning up...');
    process.exitCode = 1;
    void destroy();
  }
});
setTimeout(() => {
  console.error('Watchdog: run exceeded its time budget, exiting.');
  void destroy().finally(() => process.exit(1));
}, WATCHDOG_MS).unref();

/** Save a screenshot under artifacts/ (git-ignored); only the path is printed. */
function saveShot(name: string, png: Uint8Array) {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/${name}.png`, png);
  console.log(`[VM] Screenshot saved: artifacts/${name}.png`);
}

const mint = () => mintViewerUrl(restored?.sandbox ?? sandbox);

try {
  console.log(
    `model: ${config.model}, max steps: ${config.s1MaxSteps} (Session 1) / ${config.s2MaxSteps} (Session 2), ` +
      `time limit: ${SESSION_TIMEOUT_MS / 60_000} min per session`,
  );
  phase = 'VM start';
  await sandbox.start();
  console.log(`[VM] Created (sandbox ${shortId(sandbox.sandboxId)})`);

  phase = 'editor preflight';
  let { editor, docExists } = await preflightEditorTask(sandbox, target);
  if (!editor && config.setupEditor) {
    console.log('[SETUP] No GUI text editor found; DEMO_SETUP_EDITOR=1, installing Mousepad');
    phase = 'editor setup';
    const setup = await installMousepad(sandbox, (line) => console.log(`[SETUP] ${line}`));
    if (!setup.ok) throw new Error(`editor setup failed at ${setup.step} (${setup.failure}): ${setup.detail} (no model calls made)`);
    console.log(`[SETUP] ${setup.detail}`);
    phase = 'editor preflight after setup';
    ({ editor, docExists } = await retryReadOnlyOnce('preflight', () => preflightEditorTask(sandbox, target), (line) =>
      console.log(`[SETUP] ${line}`),
    ));
  }
  if (editor?.bin !== 'mousepad') {
    throw new Error(
      `Mousepad not found in this VM (found ${editor ? editor.bin : 'no GUI text editor'}; no model calls made). ` +
        'Set DEMO_SETUP_EDITOR=1 to install it before the agents run.',
    );
  }
  if (docExists) throw new Error(`${target} already exists before Session 1 (no model calls made)`);
  console.log(`[ENV] GUI text editor found: ${editor.name} (${editor.bin})`);
  if (config.editorLook) {
    phase = 'display settings';
    await prepareEditorLook(sandbox, (line) => console.log(line));
  }

  if (config.viewer) {
    phase = 'viewer';
    viewer = await startViewerRedirect(mint, config.viewerPort);
    console.log(`[VIEWER] Open ${viewer.localUrl} in your browser (waiting up to ${VIEWER_WAIT_MS / 60_000} min)`);
    if (!(await waitForViewer(viewer, VIEWER_WAIT_MS))) {
      throw new Error(`viewer not opened within ${VIEWER_WAIT_MS / 60_000} min (no model calls made)`);
    }
    console.log('[VIEWER] Opened (private, view-only); starting Session 1 in 5s');
    await new Promise((r) => setTimeout(r, 5_000));
  }

  ok = await runLaunchDemo({
    sandbox,
    workspace,
    editor,
    budget: pickBudget(),
    target,
    models: { session1: config.model, session2: config.model },
    maxSteps: { session1: config.s1MaxSteps, session2: config.s2MaxSteps },
    timeoutMs: SESSION_TIMEOUT_MS,
    sandboxOptions: SANDBOX_OPTIONS,
    tools: LAUNCH_TOOLS,
    onRestored: (r) => (restored = r),
    beforeSession2: config.viewer
      ? async () => {
          // The old viewer connection died with the pause; serve a fresh redirect for the reconnected VM.
          await viewer?.close();
          viewer = await startViewerRedirect(mint, config.viewerPort);
          console.log(`[VIEWER] Reload ${viewer.localUrl} to follow Session 2 (waiting up to ${VIEWER_RELOAD_WAIT_MS / 1000}s)`);
          if (await waitForViewer(viewer, VIEWER_RELOAD_WAIT_MS)) {
            console.log('[VIEWER] Reopened; starting Session 2 in 3s');
            await new Promise((r) => setTimeout(r, 3_000));
          } else {
            console.log('[VIEWER] Not reloaded in time; starting Session 2 anyway');
          }
        }
      : undefined,
    saveShot,
    onPhase: (p) => (phase = p),
    log: (line) => console.log(line),
  });
  if (!ok) process.exitCode = 1;
} catch (error) {
  // Name, code and redacted message of each error in the cause chain; never headers, URLs or keys.
  console.error(`FAIL during ${phase}: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await destroy();
  console.log(banner(ok && process.exitCode !== 1 ? '[RESULT] PASS' : '[RESULT] FAIL'));
}
