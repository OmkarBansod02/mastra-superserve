/**
 * A Mastra agent, driven by an OpenAI model, completing a small desktop task on
 * a Superserve cloud VM: open a GUI text editor, type a short document with a
 * unique token, and save it to the desktop user's home directory. The model
 * picks and calls every tool itself; the script then reads the file back
 * independently. Before any model call, a read-only command checks that the
 * VM has a GUI text editor (see examples/editor-task.ts); without one the run
 * stops with FAIL and no OpenAI usage.
 *
 * Environment (read from .env by the npm script via --env-file-if-exists):
 * - SUPERSERVE_API_KEY, OPENAI_API_KEY: required.
 * - OPENAI_MODEL: an OpenAI model with tool calling and image input, with or
 *   without the `openai/` router prefix. Default `gpt-5.4-mini`.
 * - MAX_STEPS: agent step budget, 1–15. Default 10.
 * - DEBUG_IMAGES=1: count and log the screenshots sent to OpenAI as
 *   `input_image` parts (call ids and sizes only).
 * - DEMO_MODE=1: recording mode (see docs/DEMO.md). Creates the VM up front,
 *   logs each tool call live as `[AGENT] …`, and after a passing run shows a
 *   scripted pause → new provider instance → reattach lifecycle, then
 *   confirms the VM is deleted. Ends with `[RESULT] PASS|FAIL`.
 * - DEMO_VIEWER=1 (with DEMO_MODE): serve http://localhost:7777/ (port via
 *   DEMO_VIEWER_PORT), which redirects to a fresh private, view-only desktop
 *   viewer, and wait up to 2 minutes for it to be opened before the agent
 *   starts. If it is not opened in time, the run stops with FAIL before any
 *   model call.
 * - DEMO_SETUP_EDITOR=1: if the VM has no GUI text editor, install Mousepad
 *   with apt-get (as root via passwordless sudo) before the agent starts,
 *   logged as `[SETUP] …`. If that is unsupported or fails, the run stops
 *   with FAIL before any model call. The agent still opens the editor through
 *   the desktop.
 * - DEMO_SETUP_ONLY=1: only check the Mousepad setup on one VM (see
 *   examples/setup-only.ts): create it, install and verify Mousepad, print
 *   `[SETUP] PASS|FAIL`, destroy it. No agent, no OpenAI calls, no viewer;
 *   only SUPERSERVE_API_KEY is needed.
 *
 * Steps and wall time are capped and the VM is always destroyed at the end.
 * Keys and live-viewer URLs are never printed.
 *
 *   pnpm example:agent
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Workspace } from '@mastra/core/workspace';
import type { SuperserveSandbox } from '../src/index.js';
import {
  createToolCallLogger,
  destroyAndConfirm,
  mintViewerUrl,
  shortId,
  showcasePersistence,
  startViewerRedirect,
  type ViewerRedirect,
  waitForViewer,
} from './demo.js';
import { createDesktopAgent, createDesktopWorkspace, shellWritesTo } from './desktop-agent.js';
import {
  checkDocument,
  describeError,
  DOC_PATH,
  DOC_TITLE,
  EDITOR_SETUP_TIMEOUT_SECONDS,
  editorTaskPrompt,
  installMousepad,
  preflightEditorTask,
  retryReadOnlyOnce,
  shellLaunches,
} from './editor-task.js';
import { runSetupOnly } from './setup-only.js';

const flag = (name: string) => process.env[name] === '1' || process.env[name] === 'true';
const rawModel = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
const MODEL = rawModel.startsWith('openai/') ? rawModel : `openai/${rawModel}`;
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 10);
const DEBUG_IMAGES = flag('DEBUG_IMAGES');
const DEMO_MODE = flag('DEMO_MODE');
const DEMO_VIEWER = DEMO_MODE && flag('DEMO_VIEWER');
const DEMO_VIEWER_PORT = Number(process.env.DEMO_VIEWER_PORT ?? 7777);
const DEMO_SETUP_EDITOR = flag('DEMO_SETUP_EDITOR');
const DEMO_SETUP_ONLY = flag('DEMO_SETUP_ONLY');
const RUN_TIMEOUT_MS = 5 * 60_000;
const VM_TIMEOUT_SECONDS = 600;
const VIEWER_WAIT_MS = 2 * 60_000;
/** Extra watchdog time in demo mode for the up-front VM start, viewer wait and lifecycle showcase. */
const DEMO_EXTRA_MS = 3 * 60_000 + (DEMO_VIEWER ? VIEWER_WAIT_MS : 0);
/** Extra watchdog time for the optional editor install. */
const SETUP_EXTRA_MS = DEMO_SETUP_EDITOR ? (EDITOR_SETUP_TIMEOUT_SECONDS + 60) * 1000 : 0;
const SANDBOX_OPTIONS = { namePrefix: 'mastra-openai-agent', timeoutSeconds: VM_TIMEOUT_SECONDS };

if (rawModel.includes('/') && !rawModel.startsWith('openai/')) {
  console.error(`OPENAI_MODEL must be an OpenAI model (e.g. gpt-5.4-mini), got ${JSON.stringify(rawModel)}.`);
  process.exit(1);
}
if (!Number.isInteger(MAX_STEPS) || MAX_STEPS < 1 || MAX_STEPS > 15) {
  console.error(`MAX_STEPS must be an integer from 1 to 15, got ${JSON.stringify(process.env.MAX_STEPS)}.`);
  process.exit(1);
}
if (DEMO_VIEWER && (!Number.isInteger(DEMO_VIEWER_PORT) || DEMO_VIEWER_PORT < 1024 || DEMO_VIEWER_PORT > 65535)) {
  console.error(`DEMO_VIEWER_PORT must be an integer from 1024 to 65535, got ${JSON.stringify(process.env.DEMO_VIEWER_PORT)}.`);
  process.exit(1);
}
const missing = ['SUPERSERVE_API_KEY', ...(DEMO_SETUP_ONLY ? [] : ['OPENAI_API_KEY'])].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.log(`Skipping: set ${missing.join(' and ')} (see .env.example) to run this example.`);
  process.exit(0);
}
if (DEMO_SETUP_ONLY) {
  // Returns before the fetch wrapper, the agent or any OpenAI client exists.
  process.exit(await runSetupOnly({ ...SANDBOX_OPTIONS, namePrefix: 'mastra-setup-only' }));
}

// Optional diagnostics: count the screenshots that actually go to OpenAI. The
// Responses API carries them as `input_image` parts inside
// `function_call_output` items. Only ids and sizes are recorded; request
// headers (the API key) are never touched.
const imagesSentToModel = new Map<string, number>();
const realFetch = globalThis.fetch;
if (DEBUG_IMAGES) {
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.openai.com/') && typeof init?.body === 'string') {
      for (const item of (JSON.parse(init.body) as { input?: unknown[] }).input ?? []) {
        const { type, call_id, output } = item as { type?: string; call_id?: string; output?: unknown };
        if (type !== 'function_call_output' || !Array.isArray(output)) continue;
        for (const part of output as { type?: string; image_url?: string }[]) {
          if (part.type === 'input_image' && part.image_url?.startsWith('data:image/png;base64,')) {
            imagesSentToModel.set(call_id!, part.image_url.length);
          }
        }
      }
    }
    return realFetch(input, init);
  };
}

const token = `mastra-openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const target = DOC_PATH;
const { sandbox, workspace } = createDesktopWorkspace(SANDBOX_OPTIONS);
const agent = createDesktopAgent(workspace, MODEL);
// Demo mode only: the second provider instance attached by the lifecycle showcase.
let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
let viewer: ViewerRedirect | undefined;
let demoOk = false;
/** The scripted step in progress, named in the FAIL line. */
let phase = 'start';

let destroyed: Promise<void> | undefined;
const destroy = () =>
  (destroyed ??= (async () => {
    await viewer?.close();
    // The sandbox is lazy: 'pending' means no VM was ever created.
    if (sandbox.status === 'pending') {
      console.log('cleanup: no VM was created');
      return;
    }
    const { metadata } = await sandbox.getInfo();
    const vmId = restored?.sandbox.sandboxId ?? sandbox.sandboxId;
    try {
      if (DEMO_MODE && vmId) {
        // Newest instance first; destroying the stale original afterwards is a no-op.
        const status = await destroyAndConfirm([...(restored ? [restored.workspace] : []), workspace], vmId, sandbox.id);
        if (status !== 'deleted' && status !== 'absent') throw new Error(`VM still ${status} after destroy`);
        console.log(`[VM] Destroyed (sandbox ${shortId(vmId)} no longer listed by Superserve)`);
      } else {
        await workspace.destroy();
        console.log(`cleanup: VM destroyed (status: ${sandbox.status})`);
      }
    } catch (error) {
      process.exitCode = 1;
      demoOk = false;
      console.error(`cleanup FAILED: ${error instanceof Error ? error.message : String(error)}`);
      console.error(
        `  Delete Superserve VM ${String(vmId ?? metadata?.sandboxId ?? '(unknown id)')} manually. ` +
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
// Safety net: if the event loop ever drains while the run is still awaiting
// something (Node would then exit with code 13 and skip the finally block),
// destroy the VM first. Cleanup's own network calls keep the loop alive.
process.once('beforeExit', () => {
  if (!destroyed) {
    console.error('Event loop drained before the run finished; cleaning up...');
    process.exitCode = 1;
    void destroy();
  }
});
// Last-resort guard in case cleanup itself hangs.
setTimeout(() => {
  console.error('Watchdog: run exceeded its time budget, exiting.');
  void destroy().finally(() => process.exit(1));
}, RUN_TIMEOUT_MS + 120_000 + (DEMO_MODE ? DEMO_EXTRA_MS : 0) + SETUP_EXTRA_MS).unref();

type ToolChunk = { payload?: { toolName?: string; args?: unknown; result?: unknown; isError?: boolean } };

/** Save a demo screenshot under artifacts/ (git-ignored); only the path is printed. */
function saveShot(name: string, png: Uint8Array) {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/${name}.png`, png);
  console.log(`[VM] Screenshot saved: artifacts/${name}.png`);
}

try {
  console.log(`model: ${MODEL}, max steps: ${MAX_STEPS}, time limit: ${RUN_TIMEOUT_MS / 60_000} min`);
  if (DEMO_MODE) {
    // Demo mode shows VM creation as its own step; otherwise the first command starts the VM lazily.
    phase = 'VM start';
    await sandbox.start();
    console.log(`[VM] Created (sandbox ${shortId(sandbox.sandboxId)})`);
  }
  phase = 'editor preflight';
  let { editor, docExists } = await preflightEditorTask(sandbox, target);
  if (!editor && DEMO_SETUP_EDITOR) {
    // Scripted setup before the agent runs; the model never installs or launches anything.
    console.log('[SETUP] No GUI text editor found; DEMO_SETUP_EDITOR=1, installing Mousepad');
    phase = 'editor setup';
    const setup = await installMousepad(sandbox, (line) => console.log(`[SETUP] ${line}`));
    if (!setup.ok) throw new Error(`editor setup failed at ${setup.step} (${setup.failure}): ${setup.detail} (no model calls made)`);
    console.log(`[SETUP] ${setup.detail}`);
    phase = 'editor preflight after setup';
    ({ editor, docExists } = await retryReadOnlyOnce('preflight', () => preflightEditorTask(sandbox, target), (line) =>
      console.log(`[SETUP] ${line}`),
    ));
    if (editor?.bin !== 'mousepad') throw new Error('editor setup failed: mousepad not found by the editor check after install (no model calls made)');
  }
  if (!editor) {
    throw new Error(
      'no GUI text editor installed in this VM (checked with command -v; no model calls made). ' +
        'Set DEMO_SETUP_EDITOR=1 to install Mousepad before the agent runs.',
    );
  }
  if (docExists) throw new Error(`${target} already exists before the agent ran`);
  console.log(`[ENV] GUI text editor found: ${editor.name} (${editor.bin})`);
  if (DEMO_MODE) {
    if (DEMO_VIEWER) {
      phase = 'viewer';
      viewer = await startViewerRedirect(() => mintViewerUrl(restored?.sandbox ?? sandbox), DEMO_VIEWER_PORT);
      console.log(`[VIEWER] Open ${viewer.localUrl} in your browser (waiting up to ${VIEWER_WAIT_MS / 60_000} min)`);
      if (!(await waitForViewer(viewer, VIEWER_WAIT_MS))) {
        throw new Error(`viewer not opened within ${VIEWER_WAIT_MS / 60_000} min (no model calls made)`);
      }
      console.log('[VIEWER] Opened (private, view-only); starting the agent in 5s');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  phase = 'agent run';
  const result = await agent.generate(
    editorTaskPrompt(editor, token, target),
    {
      maxSteps: MAX_STEPS,
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      ...(DEMO_MODE && { onChunk: createToolCallLogger((line) => console.log(line)) }),
    },
  );

  const calls = result.steps.flatMap((s) => s.toolResults as ToolChunk[]).map((c) => c.payload ?? {});
  console.log(`steps: ${result.steps.length}, tool calls: ${calls.length}`);
  // Demo mode already showed each call live, with sensitive arguments left out.
  if (!DEMO_MODE) {
    calls.forEach((c, i) => {
      const name = c.toolName?.replace('mastra_workspace_', '');
      console.log(`  ${i + 1}. ${name} ${JSON.stringify(c.args)}${c.isError ? ` -> ERROR ${JSON.stringify(c.result)}` : ''}`);
    });
  }
  const usedTool = (suffix: string) => calls.some((c) => c.toolName?.endsWith(suffix) && !c.isError);
  const typedToken = calls.some((c) => c.toolName?.endsWith('computer_type') && JSON.stringify(c.args).includes(token));
  const shellCommands = calls
    .filter((c) => c.toolName?.endsWith('execute_command'))
    .map((c) => String((c.args as { command?: unknown })?.command ?? ''));
  const shellWrote = shellCommands.some((cmd) => shellWritesTo(cmd, target));
  const shellLaunched = shellCommands.some((cmd) => shellLaunches(cmd, editor.bin));
  const pressedSave = calls.some((c) => {
    const key = (c.args as { key?: unknown })?.key;
    const combo = (Array.isArray(key) ? key.join('+') : String(key ?? '')).toLowerCase().replace(/\s/g, '');
    return c.toolName?.endsWith('computer_press_key') && (combo === 'ctrl+s' || combo === 'control+s');
  });

  const u = result.totalUsage;
  console.log(`usage: input ${u?.inputTokens ?? '?'} tokens, output ${u?.outputTokens ?? '?'}, total ${u?.totalTokens ?? '?'}`);
  if (DEBUG_IMAGES) {
    console.log(`screenshots sent to OpenAI as input_image: ${imagesSentToModel.size}`);
    for (const [id, size] of imagesSentToModel) console.log(`  ${id}: ${size} chars of base64 PNG`);
  }
  console.log(`agent answer: ${JSON.stringify(result.text.slice(0, 300))}`);

  // Independent check, outside the agent (read-only).
  phase = 'independent file check';
  const check = await sandbox.executeCommand('cat', [target]);
  const doc = checkDocument(check.exitCode === 0 ? check.stdout : '', token);
  const fileOk = doc.hasToken && doc.hasTitle;
  const checks: [string, boolean][] = [
    ['agent took a screenshot', usedTool('computer_screenshot')],
    ['agent clicked on the desktop', usedTool('computer_click') || usedTool('computer_double_click')],
    ['agent typed the token via the keyboard tool', typedToken],
    [`agent did not launch ${editor.bin} via the shell`, !shellLaunched],
    ['agent did not write the file via the shell', !shellWrote],
    [`${target} contains the token (checked outside the agent)`, doc.hasToken],
    [`${target} contains "${DOC_TITLE}" (checked outside the agent)`, doc.hasTitle],
    ['agent reported the token', result.text.includes(token)],
    ...(DEBUG_IMAGES ? [['screenshots reached OpenAI as input_image', imagesSentToModel.size > 0] as [string, boolean]] : []),
  ];
  for (const [name, passed] of checks) console.log(`  [${passed ? 'ok' : 'FAIL'}] ${name}`);
  // Informational: the agent may save through the File menu instead.
  console.log(`  [info] agent pressed ctrl+s: ${pressedSave}`);
  if (!fileOk) console.log(`  file contents: ${JSON.stringify(check.stdout.trim() || check.stderr.trim())}`);
  const ok = checks.every(([, passed]) => passed);
  console.log(ok ? 'PASS: the agent completed the desktop task' : 'FAIL: see the failed checks above');
  process.exitCode = ok ? 0 : 1;

  if (DEMO_MODE && ok) {
    // Scripted by this example, not chosen by the model.
    console.log('--- persistence showcase (scripted lifecycle, not agent actions) ---');
    phase = 'persistence showcase';
    saveShot('demo-1-after-agent', (await sandbox.computer.screenshot()).data);
    demoOk = await showcasePersistence({
      sandbox,
      workspace,
      target,
      expected: token,
      sandboxOptions: SANDBOX_OPTIONS,
      onRestored: (r) => (restored = r),
      onScreenshot: (png) => saveShot('demo-2-after-reconnect', png),
      log: (line) => console.log(line),
    });
    if (!demoOk) process.exitCode = 1;
  }
} catch (error) {
  // Name, code and redacted message of each error in the cause chain; never headers, URLs or keys.
  console.error(`FAIL during ${phase}: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await destroy();
  if (DEMO_MODE) console.log(demoOk && process.exitCode === 0 ? '[RESULT] PASS' : '[RESULT] FAIL');
}
