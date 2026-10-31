// DEMO_CONTINUE: a second, independent agent invocation on the reattached VM (examples/continue-session.ts).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Workspace, WorkspaceToolsConfig } from '@mastra/core/workspace';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SuperserveSandbox } from '../src/index.js';
import { fakeVm, listRow, type FakeVm } from './fakes.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  killById: vi.fn(),
}));
vi.mock('@superserve/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@superserve/sdk')>();
  return { ...actual, Sandbox: sdk };
});

const cont = await import('../examples/continue-session.js');
const demo = await import('../examples/demo.js');
const { createDesktopAgent, createDesktopWorkspace } = await import('../examples/desktop-agent.js');
const { scriptedModel } = await import('../examples/scripted-model.js');
const { DOC_PATH, DOC_TITLE } = await import('../examples/editor-task.js');

type ScriptedStep = import('../examples/scripted-model.js').ScriptedStep;

const TOKEN1 = 'mastra-openai-s1tok';
const TOKEN2 = 'mastra-session2-s2tok';
const EDITOR = { bin: 'mousepad', name: 'Mousepad' };
const FAST_POLL = { attempts: 3, intervalMs: 1 };
const TOOLS = Object.fromEntries(
  ['click', 'double_click', 'type', 'press_key'].map((n) => [`mastra_workspace_computer_${n}`, { screenshotDelayMs: 0 }]),
) as WorkspaceToolsConfig;

let vm: FakeVm;
let rows: ReturnType<typeof listRow>[];
/** The file on the VM's disk. */
let disk: string | null;
/** A simulated Mousepad window (null: not open). */
let gui: { buffer: string; caret: number; openDialog: string | null } | null;
/** Whether the editor window survives the pause (a memory snapshot keeps it). */
let windowSurvivesPause: boolean;

/** The fake desktop's input mocks, typed with the arguments the provider passes. */
const desk = () =>
  vm.desktop as unknown as {
    click: Mock<(...args: unknown[]) => Promise<void>>;
    write: Mock<(text: string) => Promise<void>>;
    press: Mock<(keys: string[]) => Promise<void>>;
  };

const call = (toolName: string, input: Record<string, unknown> = {}): ScriptedStep => ({
  toolCalls: [{ toolName: `mastra_workspace_${toolName}`, input }],
});

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-cont-1234567890');
  rows = [];
  disk = null;
  gui = null;
  windowSurvivesPause = true;
  sdk.create.mockImplementation(async (opts: { metadata: Record<string, string> }) => {
    rows = [listRow(vm.id, opts.metadata, 'active')];
    return vm;
  });
  sdk.connect.mockImplementation(async (id: string) => {
    for (const r of rows) if (r.id === id) r.status = 'active';
    return vm;
  });
  sdk.list.mockImplementation(async () => rows.map((r) => ({ ...r })));
  sdk.killById.mockImplementation(async (id: string) => {
    rows = rows.filter((r) => r.id !== id);
  });
  vm.pause.mockImplementation(async () => {
    for (const r of rows) r.status = 'paused';
    if (!windowSurvivesPause) gui = null;
  });
  vm.commands.run.mockImplementation(async (command: string) => {
    if (command.startsWith('xdotool getmouselocation')) {
      return { stdout: 'X=10\nY=20\nSCREEN=0\nWINDOW=1\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (command.startsWith('cat ')) {
      return disk === null
        ? { stdout: '', stderr: 'No such file', exitCode: 1, truncated: false }
        : { stdout: disk, stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });
  // The simulated editor: the first click opens an empty window; clicks put the
  // caret at the start; ctrl+End moves it to the end; ctrl+o + path + Enter
  // loads the file; ctrl+s saves the buffer to disk.
  desk().click.mockImplementation(async () => {
    if (!gui) gui = { buffer: '', caret: 0, openDialog: null };
    else gui.caret = 0;
  });
  const insert = (text: string) => {
    if (!gui) return;
    if (gui.openDialog !== null) return void (gui.openDialog += text);
    gui.buffer = gui.buffer.slice(0, gui.caret) + text + gui.buffer.slice(gui.caret);
    gui.caret += text.length;
  };
  desk().write.mockImplementation(async (text) => insert(text));
  desk().press.mockImplementation(async (keys) => {
    if (!gui) return;
    const combo = keys.join('+');
    if (combo === 'ctrl+End') gui.caret = gui.buffer.length;
    else if (combo === 'ctrl+o') gui.openDialog = '';
    else if (combo === 'ctrl+a') {
      gui.buffer = '';
      gui.caret = 0;
    } else if (combo === 'Return' && gui.openDialog !== null) {
      if (gui.openDialog === DOC_PATH && disk !== null) gui.buffer = disk;
      gui.caret = 0;
      gui.openDialog = null;
    } else if (combo === 'Return') insert('\n');
    else if (combo === 'ctrl+s') disk = gui.buffer;
  });
});

const SESSION1: ScriptedStep[] = [
  call('computer_screenshot'),
  call('computer_click', { x: 20, y: 10 }), // Applications → Mousepad
  call('computer_click', { x: 400, y: 300 }), // text area
  call('computer_type', { text: DOC_TITLE }),
  call('computer_press_key', { key: 'Enter' }),
  call('computer_type', { text: `Verification token: ${TOKEN1}` }),
  call('computer_press_key', { key: 'ctrl+s' }),
  call('execute_command', { command: `cat ${DOC_PATH}` }),
  { text: `RESULT: ${TOKEN1}` },
];

const appendSteps = (token = TOKEN2): ScriptedStep[] => [
  call('computer_click', { x: 400, y: 300 }),
  call('computer_press_key', { key: 'ctrl+End' }),
  call('computer_press_key', { key: 'Enter' }),
  call('computer_type', { text: cont.SESSION2_HEADING }),
  call('computer_press_key', { key: 'Enter' }),
  call('computer_type', { text: `${cont.SESSION2_TOKEN_LABEL} ${token}` }),
  call('computer_press_key', { key: 'ctrl+s' }),
  call('computer_screenshot'),
  call('execute_command', { command: `cat ${DOC_PATH}` }),
  { text: `RESULT: ${token}` },
];
const SESSION2: ScriptedStep[] = [call('computer_screenshot'), ...appendSteps()];

type Model = Parameters<typeof createDesktopAgent>[1];

/**
 * Mirrors the DEMO_CONTINUE path of examples/agent.ts: Session 1, then
 * runContinueDemo, with cleanup in `finally` destroying the newest instance
 * first, then the original.
 */
async function runDemo(
  session2: Model,
  opts: { timeoutMs?: number; maxSteps?: number; ctl?: { destroy?: () => Promise<string> } } = {},
) {
  const prompts1: unknown[] = [];
  const s1 = createDesktopWorkspace({ namePrefix: 'mastra-openai-agent' }, TOOLS);
  const lines: string[] = [];
  const shots: string[] = [];
  const phases: string[] = [];
  let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
  let ok = false;
  let error: unknown;
  let status = '';
  // Idempotent, like destroy() in examples/agent.ts: the signal handlers, the
  // watchdog and `finally` all share one cleanup.
  let destroyed: Promise<string> | undefined;
  const destroy = () =>
    (destroyed ??= demo.destroyAndConfirm([...(restored ? [restored.workspace] : []), s1.workspace], vm.id, s1.sandbox.id, FAST_POLL));
  if (opts.ctl) opts.ctl.destroy = destroy;
  try {
    await s1.sandbox.start();
    const agent1 = createDesktopAgent(s1.workspace, scriptedModel(SESSION1, { onPrompt: (p) => prompts1.push(p) }));
    lines.push('=== Session 1 ===');
    await agent1.generate('session 1 task', {
      maxSteps: 15,
      onChunk: demo.createToolCallLogger((l) => lines.push(l.replace(/^\[AGENT\]/, '[AGENT S1]'))),
    });
    ok = await cont.runContinueDemo({
      sandbox: s1.sandbox,
      workspace: s1.workspace,
      target: DOC_PATH,
      editor: EDITOR,
      session1Token: TOKEN1,
      session2Token: TOKEN2,
      model: session2,
      maxSteps: opts.maxSteps ?? 15,
      timeoutMs: opts.timeoutMs ?? 30_000,
      tools: TOOLS,
      onRestored: (r) => (restored = r),
      saveShot: (name) => shots.push(name),
      onPhase: (p) => phases.push(p),
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });
  } catch (e) {
    error = e;
  } finally {
    status = await destroy();
  }
  return { ok, error, status, lines, shots, phases, restored, s1, prompts1 };
}

function expectCleanedUp(r: Awaited<ReturnType<typeof runDemo>>) {
  expect(r.status).toBe('absent');
  expect(sdk.killById).toHaveBeenCalledWith(vm.id, {});
  expect(rows).toEqual([]);
  expect(r.s1.sandbox.status).toBe('destroyed');
  if (r.restored) expect(r.restored.sandbox.status).toBe('destroyed');
  expect(sdk.create).toHaveBeenCalledTimes(1); // never a second VM, not even during cleanup
}

describe('continueConfig (DEMO_CONTINUE flag)', () => {
  it('is off by default and with DEMO_MODE alone, so the original demo is unchanged', () => {
    expect(cont.continueConfig({})).toEqual({ enabled: false });
    expect(cont.continueConfig({ DEMO_MODE: '1' })).toEqual({ enabled: false });
    expect(cont.continueConfig({ DEMO_MODE: '1', DEMO_CONTINUE: '0' })).toEqual({ enabled: false });
  });

  it('is on with DEMO_MODE=1 and DEMO_CONTINUE=1, with a bounded Session 2 step budget', () => {
    expect(cont.continueConfig({ DEMO_MODE: '1', DEMO_CONTINUE: '1' })).toEqual({ enabled: true, maxSteps: 15 });
    expect(cont.continueConfig({ DEMO_MODE: 'true', DEMO_CONTINUE: 'true', DEMO_CONTINUE_MAX_STEPS: '20' })).toEqual({
      enabled: true,
      maxSteps: 20,
    });
  });

  it('rejects DEMO_CONTINUE without DEMO_MODE and out-of-range step budgets', () => {
    expect(() => cont.continueConfig({ DEMO_CONTINUE: '1' })).toThrow('DEMO_CONTINUE=1 needs DEMO_MODE=1');
    for (const v of ['0', '21', '2.5', 'many']) {
      expect(() => cont.continueConfig({ DEMO_MODE: '1', DEMO_CONTINUE: '1', DEMO_CONTINUE_MAX_STEPS: v })).toThrow(
        'DEMO_CONTINUE_MAX_STEPS must be an integer from 1 to 20',
      );
    }
  });

  it('is ignored under DEMO_SETUP_ONLY (no agent runs there)', () => {
    expect(cont.continueConfig({ DEMO_SETUP_ONLY: '1', DEMO_CONTINUE: '1' })).toEqual({ enabled: false });
  });
});

describe('continuationPrompt', () => {
  const prompt = cont.continuationPrompt(EDITOR, TOKEN2, DOC_PATH);

  it('names the file, the new heading and token, and the GUI route, with no coordinates', () => {
    expect(prompt).toContain(DOC_PATH);
    expect(prompt).toContain(cont.SESSION2_HEADING);
    expect(prompt).toContain(`${cont.SESSION2_TOKEN_LABEL} ${TOKEN2}`);
    expect(prompt).toContain('ctrl+End');
    expect(prompt).toContain('Applications');
    expect(prompt).toContain('Do not open the editor or the file from a terminal or with execute_command');
    expect(prompt).not.toMatch(/\(\s*\d+\s*,\s*\d+\s*\)|\bx\s*[:=]\s*\d|\by\s*[:=]\s*\d/);
  });

  it('carries nothing from Session 1', () => {
    expect(prompt).not.toContain(TOKEN1);
    expect(prompt).not.toContain('Verification token');
  });
});

describe('checkContinuedDocument', () => {
  const tokens = { session1: TOKEN1, session2: TOKEN2 };
  const s1 = `${DOC_TITLE}\nVerification token: ${TOKEN1}`;

  it('passes when the Session 2 section follows the untouched Session 1 content', () => {
    expect(cont.checkContinuedDocument(`${s1}\n${cont.SESSION2_HEADING}\nSession 2 token: ${TOKEN2}`, tokens)).toEqual({
      hasTitle: true,
      hasSession1Token: true,
      hasHeading: true,
      hasSession2Token: true,
      appended: true,
    });
  });

  it('flags a replaced document, a section inserted before Session 1, and a missing Session 2 token', () => {
    const replaced = cont.checkContinuedDocument(`${cont.SESSION2_HEADING}\nSession 2 token: ${TOKEN2}`, tokens);
    expect(replaced).toMatchObject({ hasTitle: false, hasSession1Token: false, appended: false });
    const prepended = cont.checkContinuedDocument(`${cont.SESSION2_HEADING}\n${s1}`, tokens);
    expect(prepended).toMatchObject({ hasSession1Token: true, hasHeading: true, appended: false });
    expect(cont.checkContinuedDocument(s1, tokens)).toMatchObject({ hasHeading: false, hasSession2Token: false });
  });
});

describe('shellModifies / shellSendsInput (Session 2 must not edit through the shell)', () => {
  it.each([
    `echo x >> ${DOC_PATH}`,
    'printf "x" >> ~/mastra-superserve-demo.txt',
    'echo x | tee -a mastra-superserve-demo.txt',
    `sed -i '$a x' ${DOC_PATH}`,
    `perl -pi -e 's/a/b/' ${DOC_PATH}`,
    `python3 -c "open('${DOC_PATH}','a').write('x')"`,
    `truncate -s 0 ${DOC_PATH}`,
    `rm ${DOC_PATH}`,
    `cp /tmp/x ${DOC_PATH}`,
  ])('flags %s', (command) => expect(cont.shellModifies(command, DOC_PATH)).toBe(true));

  it.each([`cat ${DOC_PATH}`, `cat ${DOC_PATH} 2>/dev/null`, `wc -l ${DOC_PATH}`, `grep -c Session ${DOC_PATH}`, 'ls -la ~', 'echo $DISPLAY'])(
    'ignores %s',
    (command) => expect(cont.shellModifies(command, DOC_PATH)).toBe(false),
  );

  it('flags desktop input sent through xdotool, not window lookups', () => {
    expect(cont.shellSendsInput('xdotool type "Session 2"')).toBe(true);
    expect(cont.shellSendsInput('DISPLAY=:0 xdotool key ctrl+s')).toBe(true);
    expect(cont.shellSendsInput('xdotool search --name Mousepad')).toBe(false);
    expect(cont.shellSendsInput('xdotool getmouselocation')).toBe(false);
  });
});

describe('runContinueDemo: Session 2 on the reconnected VM', () => {
  it('runs a second, independent model invocation on a new workspace bound to the same VM and verifies both tokens', async () => {
    const prompts2: unknown[] = [];
    const r = await runDemo(scriptedModel(SESSION2, { onPrompt: (p) => prompts2.push(p) }));

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(disk).toBe(`${DOC_TITLE}\nVerification token: ${TOKEN1}\n${cont.SESSION2_HEADING}\n${cont.SESSION2_TOKEN_LABEL} ${TOKEN2}`);

    // A new provider instance and workspace, attached to the same VM (no replacement).
    expect(r.restored).toBeDefined();
    expect(r.restored!.sandbox).not.toBe(r.s1.sandbox);
    expect(r.restored!.workspace).not.toBe(r.s1.workspace);
    expect(r.lines).toContain('[VM] Reconnected to same sandbox vm-cont- (ownership: adopted)');
    // One reconnect: Session 2 ran on the reattached instance, not by resuming the old one.
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledWith(vm.id, {});
    const reconnectedAt = sdk.connect.mock.invocationCallOrder[0]!;
    const s2Writes = desk()
      .write.mock.calls.map((c, i) => ({ text: c[0], order: desk().write.mock.invocationCallOrder[i]! }))
      .filter((w) => w.text.includes('Session 2'));
    expect(s2Writes).toHaveLength(2);
    for (const w of s2Writes) expect(w.order).toBeGreaterThan(reconnectedAt);

    // Two independent invocations: Session 2's first model call holds only its own task.
    expect(r.prompts1.length).toBeGreaterThan(0);
    expect(prompts2.length).toBe(SESSION2.length);
    const first = prompts2[0] as { role: string; content: unknown }[];
    expect(first.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(first.some((m) => m.role === 'assistant' || m.role === 'tool')).toBe(false);
    expect(JSON.stringify(first)).not.toContain(TOKEN1);
    expect(JSON.stringify(first)).not.toContain('session 1 task');
    expect(JSON.stringify(first)).toContain(TOKEN2);

    // Labelled logs, no memory claims, screenshots for the recording.
    expect(r.lines).toContain('[AGENT S1] computer_click (20, 10)');
    expect(r.lines).toContain('=== Session 2: new Mastra agent invocation on the reconnected VM ===');
    expect(r.lines).toContain('[AGENT S2] computer_press_key ctrl+End');
    expect(r.lines.some((l) => l.includes('no messages, reasoning or memory from Session 1'))).toBe(true);
    expect(r.lines.join('\n')).not.toMatch(/remembers|recalls|memory persisted/i);
    expect(r.lines.filter((l) => l.startsWith('  [FAIL]'))).toEqual([]);
    expect(r.lines).toContain('[SESSION 2] PASS: the second agent continued the document on the same VM');
    expect(r.lines).toContain('[VM] No replacement VM: Superserve lists exactly one VM for this sandbox (vm-cont-); keeping it for Session 2');
    expect(r.shots).toEqual(['demo-2-after-reconnect', 'demo-3-after-session-2']);
    expect(r.phases).toEqual(['persistence showcase', 'replacement VM check', 'session 2 agent run', 'session 2 independent check']);

    // Not destroyed by runContinueDemo; the caller's cleanup did it.
    expectCleanedUp(r);
  });

  it('reopens the file through the GUI when the editor window did not survive the pause', async () => {
    windowSurvivesPause = false;
    const r = await runDemo(
      scriptedModel([
        call('computer_screenshot'),
        call('computer_click', { x: 20, y: 10 }), // Applications → Mousepad (new empty window)
        call('computer_press_key', { key: 'ctrl+o' }),
        call('computer_type', { text: DOC_PATH }),
        call('computer_press_key', { key: 'Enter' }),
        ...appendSteps(),
      ]),
    );
    expect(r.ok).toBe(true);
    expect(disk).toContain(TOKEN1);
    expect(disk).toContain(TOKEN2);
    expectCleanedUp(r);
  });

  it('fails the checks when Session 2 typed at the caret instead of appending (Session 1 text kept, order wrong)', async () => {
    const r = await runDemo(scriptedModel([call('computer_screenshot'), ...appendSteps().filter((s) => !JSON.stringify(s).includes('ctrl+End'))]));
    expect(r.ok).toBe(false);
    expect(r.lines).toContain('  [FAIL] Session 2 section comes after the Session 1 content');
    expectCleanedUp(r);
  });

  it('fails the checks when Session 2 replaced the document (Session 1 token lost)', async () => {
    const steps = appendSteps();
    steps.splice(1, 0, call('computer_press_key', { key: 'ctrl+a' }));
    const r = await runDemo(scriptedModel([call('computer_screenshot'), ...steps]));
    expect(r.ok).toBe(false);
    expect(r.lines).toContain(`  [FAIL] ${DOC_PATH} still contains the Session 1 token`);
    expectCleanedUp(r);
  });

  it('fails when Session 2 appends through the shell instead of the GUI', async () => {
    const r = await runDemo(
      scriptedModel([
        call('computer_screenshot'),
        call('execute_command', { command: `printf '\\n${cont.SESSION2_HEADING}\\n${TOKEN2}' >> ${DOC_PATH}` }),
        { text: `RESULT: ${TOKEN2}` },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.lines).toContain('  [FAIL] Session 2 agent did not modify the file via the shell');
    expect(r.lines).toContain('  [FAIL] Session 2 agent typed its token via the keyboard tool');
    expectCleanedUp(r);
  });

  it('propagates a model failure during Session 2, and cleanup still destroys the VM', async () => {
    const boom = () => Promise.reject(new Error('model API error 500'));
    const failing = new MastraLanguageModelV2Mock({ doGenerate: boom, doStream: boom });
    const r = await runDemo(failing);
    expect(r.ok).toBe(false);
    expect(r.phases.at(-1)).toBe('session 2 agent run');
    expect(disk).not.toContain(TOKEN2);
    expectCleanedUp(r);
  });

  it('stops Session 2 at its time limit, and cleanup still destroys the VM', async () => {
    const hang = (o: { abortSignal?: AbortSignal }) =>
      new Promise<never>((_, reject) => o.abortSignal?.addEventListener('abort', () => reject(o.abortSignal!.reason)));
    const started = Date.now();
    const r = await runDemo(new MastraLanguageModelV2Mock({ doGenerate: hang, doStream: hang }), { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.ok).toBe(false);
    // Mastra ends an aborted run without throwing; the independent checks then fail.
    expect(r.phases).toContain('session 2 agent run');
    expect(r.lines).toContain(`  [FAIL] ${DOC_PATH} contains the Session 2 token`);
    expect(disk).not.toContain(TOKEN2);
    expectCleanedUp(r);
  }, 10_000);

  it('interruption mid-Session 2: cleanup destroys the VM and the in-flight run never creates a new one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let interrupted!: () => void;
    const midSession = new Promise<void>((r) => (interrupted = r));
    // Hold Session 2's first click (after the reconnect) in flight.
    const click = desk().click.getMockImplementation()!;
    desk().click.mockImplementation(async (...args) => {
      if (sdk.connect.mock.calls.length > 0) {
        interrupted();
        await gate;
      }
      return click(...args);
    });
    const ctl: { destroy?: () => Promise<string> } = {};
    const run = runDemo(scriptedModel(SESSION2), { ctl });
    await midSession;
    // What the SIGINT handler in examples/agent.ts does while the agent is mid-run.
    await expect(ctl.destroy!()).resolves.toBe('absent');
    const [writes, presses] = [vm.desktop.write.mock.calls.length, vm.desktop.press.mock.calls.length];
    release();
    const r = await run;
    expect(r.ok).toBe(false);
    // Nothing reached the VM after it was destroyed, and no new VM was created for the remaining steps.
    expect(vm.desktop.write.mock.calls.length).toBe(writes);
    expect(vm.desktop.press.mock.calls.length).toBe(presses);
    expect(disk).not.toContain(TOKEN2);
    expectCleanedUp(r);
  });

  it('stops before Session 2 when Superserve lists a replacement VM, and makes no Session 2 model call', async () => {
    const prompts2: unknown[] = [];
    sdk.connect.mockImplementation(async (id: string) => {
      for (const r of rows) if (r.id === id) r.status = 'active';
      rows.push(listRow('vm-other-999', rows[0]!.metadata, 'active'));
      return vm;
    });
    const r = await runDemo(scriptedModel(SESSION2, { onPrompt: (p) => prompts2.push(p) }));
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toBe('[VM] FAILED: replacement VM check (Superserve lists 2 VMs: vm-cont-, vm-other)');
    expect(prompts2).toEqual([]);
    expect(r.status).toBe('absent'); // this run's VM is gone
    expect(sdk.killById).toHaveBeenCalledWith(vm.id, {});
  });

  it('stops before Session 2 when the reconnect fails, and cleanup destroys the VM through either instance', async () => {
    const prompts2: unknown[] = [];
    sdk.connect.mockRejectedValue(new Error('connect refused'));
    const r = await runDemo(scriptedModel(SESSION2, { onPrompt: (p) => prompts2.push(p) }));
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.phases.at(-1)).toBe('persistence showcase');
    expect(prompts2).toEqual([]);
    expectCleanedUp(r);
  });

  it('stops before Session 2 when the Session 1 file is missing after reconnect', async () => {
    const prompts2: unknown[] = [];
    vm.pause.mockImplementation(async () => {
      for (const r of rows) r.status = 'paused';
      disk = null;
    });
    const r = await runDemo(scriptedModel(SESSION2, { onPrompt: (p) => prompts2.push(p) }));
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toBe('[VM] FAILED: file check after reattach (exit 1)');
    expect(prompts2).toEqual([]);
    expectCleanedUp(r);
  });
});

describe('examples/agent.ts entry point (no keys, no network)', () => {
  const script = fileURLToPath(new URL('../examples/agent.ts', import.meta.url));
  function run(env: Record<string, string>) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const { SUPERSERVE_API_KEY: _a, OPENAI_API_KEY: _b, ...base } = process.env;
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        env: { PATH: base.PATH ?? '', HOME: base.HOME ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c));
      child.stderr.on('data', (c: Buffer) => (out += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  it('without DEMO_CONTINUE behaves as before (skips without keys)', async () => {
    const { code, out } = await run({ DEMO_MODE: '1' });
    expect(out).toContain('Skipping: set SUPERSERVE_API_KEY and OPENAI_API_KEY');
    expect(out).not.toContain('DEMO_CONTINUE');
    expect(code).toBe(0);
  }, 30_000);

  it('refuses DEMO_CONTINUE without DEMO_MODE before doing anything', async () => {
    const { code, out } = await run({ DEMO_CONTINUE: '1' });
    expect(out).toContain('DEMO_CONTINUE=1 needs DEMO_MODE=1');
    expect(code).toBe(1);
  }, 30_000);
});
