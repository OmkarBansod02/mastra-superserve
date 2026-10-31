/**
 * `DEMO_CONTINUE=1` (with `DEMO_MODE=1`): a second, independent Mastra agent
 * invocation on the same Superserve VM, after the scripted pause/reattach.
 *
 * - Session 1 is the existing editor task in examples/agent.ts, unchanged.
 * - Phase 2 reuses `showcasePersistence`: pause, a new `SuperserveSandbox`
 *   built from the saved `sandboxId`, reattach, file check. Nothing is
 *   destroyed here; the caller's cleanup owns that.
 * - Session 2 is a new `Agent` on the reconnected instance's workspace. It
 *   gets only its own task (the file path and a new token): no messages,
 *   reasoning or memory from Session 1. Only the VM (disk and desktop)
 *   carries over.
 * - Phase 4 checks the file with a read-only `cat` outside the agent, and the
 *   agent's tool calls for GUI use and shell edits.
 */
import type { Agent } from '@mastra/core/agent';
import type { Workspace, WorkspaceToolsConfig } from '@mastra/core/workspace';
import { Sandbox as SdkSandbox } from '@superserve/sdk';
import { SANDBOX_ID_METADATA_KEY, type SuperserveSandbox, type SuperserveSandboxOptions } from '../src/index.js';
import { createToolCallLogger, type Log, shortId, showcasePersistence } from './demo.js';
import { createDesktopAgent, shellWritesTo } from './desktop-agent.js';
import { DOC_TITLE, type GuiEditor, shellLaunches } from './editor-task.js';

export const SESSION2_HEADING = 'Session 2: Continued after reconnect';
export const SESSION2_TOKEN_LABEL = 'Session 2 token:';
export const SESSION2_MAX_STEPS_DEFAULT = 15;
export const SESSION2_MAX_STEPS_LIMIT = 20;

export type ContinueConfig = { enabled: false } | { enabled: true; maxSteps: number };

/**
 * Read `DEMO_CONTINUE` and `DEMO_CONTINUE_MAX_STEPS`. Off unless
 * `DEMO_CONTINUE=1`; ignored under `DEMO_SETUP_ONLY` (which runs no agent).
 * Throws with a user-facing message when the flag is set without `DEMO_MODE`
 * or the step budget is out of range.
 */
export function continueConfig(env: Record<string, string | undefined>): ContinueConfig {
  const flag = (name: string) => env[name] === '1' || env[name] === 'true';
  if (!flag('DEMO_CONTINUE') || flag('DEMO_SETUP_ONLY')) return { enabled: false };
  if (!flag('DEMO_MODE')) throw new Error('DEMO_CONTINUE=1 needs DEMO_MODE=1 (it continues the demo-mode lifecycle).');
  const raw = env.DEMO_CONTINUE_MAX_STEPS;
  const maxSteps = Number(raw ?? SESSION2_MAX_STEPS_DEFAULT);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > SESSION2_MAX_STEPS_LIMIT) {
    throw new Error(`DEMO_CONTINUE_MAX_STEPS must be an integer from 1 to ${SESSION2_MAX_STEPS_LIMIT}, got ${JSON.stringify(raw)}.`);
  }
  return { enabled: true, maxSteps };
}

/**
 * Session 2's task. Names the file and the editor, gives no coordinates, and
 * carries nothing from Session 1 (not its token, prompt or answer).
 */
export function continuationPrompt(editor: GuiEditor, token: string, path: string): string {
  const file = path.split('/').pop();
  return [
    'Task on the Linux (XFCE) desktop. A text file already exists at:',
    `   ${path}`,
    `Append a new section to the end of it with the ${editor.name} text editor, through the desktop, and save it.`,
    '1. Take a screenshot to see the desktop.',
    `2. If a ${editor.name} window with that file is already open (its title shows ${file}), use that window.`,
    `   Otherwise open ${editor.name} through the desktop (the "Applications" menu at the top left, or the`,
    '   application finder in the bottom dock), press ctrl+o, type the full path above into the file name field',
    '   and press Enter. Do not open the editor or the file from a terminal or with execute_command.',
    "3. Click in the editor's text area so it has focus, then press ctrl+End with the key tool to move to the end.",
    '   Keep the existing text: do not select, replace or delete anything.',
    '4. Press Enter with the key tool, then with the type tool type this line exactly:',
    `   ${SESSION2_HEADING}`,
    '   then press Enter with the key tool, and type this line exactly:',
    `   ${SESSION2_TOKEN_LABEL} ${token}`,
    '5. Save with ctrl+s (same file; if asked whether to overwrite, confirm). Take a screenshot to confirm the save.',
    `6. Check with execute_command: cat ${path}`,
    'Do not create, modify or open the file with execute_command; use it only for that check.',
    'Finish with one line: "RESULT: <token>" or "FAILED: <reason>".',
  ].join('\n');
}

/** What the independent check found in the document after Session 2. */
export function checkContinuedDocument(contents: string, tokens: { session1: string; session2: string }) {
  const s1 = contents.indexOf(tokens.session1);
  const heading = contents.indexOf(SESSION2_HEADING);
  return {
    hasTitle: contents.includes(DOC_TITLE),
    hasSession1Token: s1 >= 0,
    hasHeading: heading >= 0,
    hasSession2Token: contents.includes(tokens.session2),
    /** The new section comes after Session 1's content, not in place of it. */
    appended: s1 >= 0 && heading > s1,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a shell command could change `path`: `shellWritesTo`'s writes,
 * plus redirects/tee to any path ending in the file name (`~/…`, relative),
 * in-place editors (`sed -i`, `perl -i`), and editing, deleting or scripting
 * tools named alongside the file. Reads (`cat`, `grep`, `wc`, `ls`) do not count.
 */
export function shellModifies(command: string, path: string): boolean {
  if (shellWritesTo(command, path)) return true;
  const file = escape(path.split('/').pop()!);
  if (new RegExp(`(>>?|\\btee\\b[^|;&]*)\\s*['"]?\\S*${file}(?![\\w.-])`).test(command)) return true;
  if (!new RegExp(`${file}(?![\\w.-])`).test(command)) return false;
  return /\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i|\b(ed|ex|vi|vim|nano|truncate|dd|rm|mv|cp|install|python3?|node|awk|ruby)\b/.test(command);
}

/** Whether a shell command sends keyboard or mouse input to the desktop (bypassing the computer tools). */
export function shellSendsInput(command: string): boolean {
  return /\b(xdotool|ydotool|wtype)\b[^|;&]*\b(type|key|keydown|keyup|click|mousemove|mousedown|mouseup)\b/.test(command);
}

export interface SessionCall {
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

/** What Session 2's tool calls show about how it worked. */
export function reviewSessionCalls(calls: SessionCall[], o: { target: string; editorBin: string; token: string }) {
  const used = (suffix: string) => calls.some((c) => c.toolName?.endsWith(suffix) && !c.isError);
  const typed = (needle: string) =>
    calls.some((c) => c.toolName?.endsWith('computer_type') && !c.isError && JSON.stringify(c.args ?? {}).includes(needle));
  const shell = calls
    .filter((c) => c.toolName?.endsWith('execute_command'))
    .map((c) => String((c.args as { command?: unknown } | undefined)?.command ?? ''));
  return {
    screenshot: used('computer_screenshot'),
    clicked: used('computer_click') || used('computer_double_click'),
    pressedKey: used('computer_press_key'),
    typedHeading: typed(SESSION2_HEADING),
    typedToken: typed(o.token),
    shellCommands: shell.length,
    shellModified: shell.some((cmd) => shellModifies(cmd, o.target)),
    shellLaunched: shell.some((cmd) => shellLaunches(cmd, o.editorBin)),
    shellInput: shell.some(shellSendsInput),
  };
}

/** Ids of the VMs Superserve lists for a logical sandbox id (deleted ones are not listed). */
export async function listVmIds(logicalId: string): Promise<string[]> {
  const rows = await SdkSandbox.list({ metadata: { [SANDBOX_ID_METADATA_KEY]: logicalId } });
  return rows.filter((r) => r.status !== 'deleted').map((r) => r.id);
}

type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];
type ToolStep = { toolResults: { payload?: SessionCall }[] };

export interface ContinueDemoOptions {
  /** Session 1's sandbox and workspace (the agent has finished and passed). */
  sandbox: SuperserveSandbox;
  workspace: Workspace;
  target: string;
  editor: GuiEditor;
  /** Session 1's token, used only by the independent checks (never shown to Session 2). */
  session1Token: string;
  session2Token: string;
  model: AgentModel;
  maxSteps: number;
  /** Wall-time limit for Session 2's agent run. */
  timeoutMs: number;
  sandboxOptions?: SuperserveSandboxOptions;
  tools?: WorkspaceToolsConfig;
  /** As in `showcasePersistence`: hand the new instance to the caller's cleanup. */
  onRestored: (restored: { sandbox: SuperserveSandbox; workspace: Workspace }) => void;
  /** Save a screenshot for the recording (PNG bytes). */
  saveShot?: (name: string, png: Uint8Array) => void;
  /** The scripted step in progress, for the caller's FAIL line. */
  onPhase?: (phase: string) => void;
  log: Log;
  poll?: { attempts?: number; intervalMs?: number };
}

/**
 * Phase 2 (pause → new instance → reattach), Session 2 (a fresh agent on the
 * reattached instance) and Phase 4 (independent checks). Returns whether all
 * passed. Errors (provider, model, timeout) propagate. Never destroys the VM:
 * the instance is handed to `onRestored` before it attaches, so the caller's
 * cleanup destroys it on success, failure, timeout or interruption.
 */
export async function runContinueDemo(o: ContinueDemoOptions): Promise<boolean> {
  const { sandbox, target, log } = o;
  const phase = (name: string) => o.onPhase?.(name);
  const savedId = sandbox.sandboxId;
  let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;

  phase('persistence showcase');
  const persisted = await showcasePersistence({
    sandbox,
    workspace: o.workspace,
    target,
    expected: o.session1Token,
    sandboxOptions: o.sandboxOptions,
    tools: o.tools,
    onRestored: (r) => {
      restored = r;
      o.onRestored(r);
    },
    onScreenshot: (png) => o.saveShot?.('demo-2-after-reconnect', png),
    log,
    poll: o.poll,
  });
  if (!persisted || !restored || !savedId) return false;

  phase('replacement VM check');
  const ids = await listVmIds(sandbox.id);
  if (ids.length !== 1 || ids[0] !== savedId) {
    log(`[VM] FAILED: replacement VM check (Superserve lists ${ids.length} VMs: ${ids.map(shortId).join(', ') || 'none'})`);
    return false;
  }
  log(`[VM] No replacement VM: Superserve lists exactly one VM for this sandbox (${shortId(savedId)}); keeping it for Session 2`);

  log('=== Session 2: new Mastra agent invocation on the reconnected VM ===');
  log(
    `[SESSION 2] New Agent bound to the reconnected SuperserveSandbox (${shortId(restored.sandbox.sandboxId)}). ` +
      'It gets no messages, reasoning or memory from Session 1; only the VM (files and desktop) carried over.',
  );
  phase('session 2 agent run');
  const agent = createDesktopAgent(restored.workspace, o.model);
  const result = await agent.generate(continuationPrompt(o.editor, o.session2Token, target), {
    maxSteps: o.maxSteps,
    abortSignal: AbortSignal.timeout(o.timeoutMs),
    onChunk: createToolCallLogger((line) => log(line.replace(/^\[AGENT\]/, '[AGENT S2]'))),
  });

  const calls = (result.steps as ToolStep[]).flatMap((s) => s.toolResults).map((c) => c.payload ?? {});
  const review = reviewSessionCalls(calls, { target, editorBin: o.editor.bin, token: o.session2Token });
  const u = result.totalUsage;
  log(`[SESSION 2] steps: ${result.steps.length}, tool calls: ${calls.length}, shell commands: ${review.shellCommands}`);
  log(`[SESSION 2] usage: input ${u?.inputTokens ?? '?'} tokens, output ${u?.outputTokens ?? '?'}, total ${u?.totalTokens ?? '?'}`);
  log(`[SESSION 2] agent answer: ${JSON.stringify(result.text.slice(0, 300))}`);

  // Independent checks, outside the agent (read-only).
  phase('session 2 independent check');
  const check = await restored.sandbox.executeCommand('cat', [target]);
  const doc = checkContinuedDocument(check.exitCode === 0 ? check.stdout : '', {
    session1: o.session1Token,
    session2: o.session2Token,
  });
  const finalIds = await listVmIds(sandbox.id);
  o.saveShot?.('demo-3-after-session-2', (await restored.sandbox.computer.screenshot()).data);

  const checks: [string, boolean][] = [
    [
      `same sandboxId for Session 1, reconnect and Session 2 (${shortId(savedId)})`,
      restored.sandbox.sandboxId === savedId && finalIds.length === 1 && finalIds[0] === savedId,
    ],
    ['Session 2 agent took a screenshot', review.screenshot],
    ['Session 2 agent clicked on the desktop', review.clicked],
    ['Session 2 agent used the key tool', review.pressedKey],
    ['Session 2 agent typed the heading via the keyboard tool', review.typedHeading],
    ['Session 2 agent typed its token via the keyboard tool', review.typedToken],
    [`Session 2 agent did not launch ${o.editor.bin} via the shell`, !review.shellLaunched],
    ['Session 2 agent did not modify the file via the shell', !review.shellModified],
    ['Session 2 agent did not send desktop input via the shell', !review.shellInput],
    [`${target} still contains "${DOC_TITLE}" (Session 1)`, doc.hasTitle],
    [`${target} still contains the Session 1 token`, doc.hasSession1Token],
    [`${target} contains "${SESSION2_HEADING}"`, doc.hasHeading],
    [`${target} contains the Session 2 token`, doc.hasSession2Token],
    ['Session 2 section comes after the Session 1 content', doc.appended],
    ['Session 2 agent reported its token', result.text.includes(o.session2Token)],
  ];
  for (const [name, passed] of checks) log(`  [${passed ? 'ok' : 'FAIL'}] ${name}`);
  const ok = checks.every(([, passed]) => passed);
  if (!ok) log(`  file contents: ${JSON.stringify(check.stdout.trim() || check.stderr.trim())}`);
  log(ok ? '[SESSION 2] PASS: the second agent continued the document on the same VM' : '[SESSION 2] FAIL: see the failed checks above');
  return ok;
}
