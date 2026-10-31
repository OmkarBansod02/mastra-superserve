// Launch-plan demo: two independent agent invocations on one VM (examples/launch-task.ts).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Workspace, WorkspaceToolsConfig } from '@mastra/core/workspace';
import { Agent } from '@mastra/core/agent';
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

const L = await import('../examples/launch-task.js');
const demo = await import('../examples/demo.js');
const { createDesktopAgent, createDesktopWorkspace } = await import('../examples/desktop-agent.js');
const { scriptedModel } = await import('../examples/scripted-model.js');

type ScriptedStep = import('../examples/scripted-model.js').ScriptedStep;
type Model = Parameters<typeof scriptedModel>[0];

const PATH = L.LAUNCH_DOC_PATH;
const EDITOR = { bin: 'mousepad', name: 'Mousepad' };
const BUDGET = { design: 400, hosting: 150, promotion: 250 };
const TOTAL = 800;
const DRAFT = L.draftLines(BUDGET);
const DRAFT_TEXT = DRAFT.join('\n');
const FINAL_DOC = L.finalLines(BUDGET).join('\n');
const FAST_POLL = { attempts: 3, intervalMs: 1 };
const TOOLS = Object.fromEntries(
  ['click', 'double_click', 'type', 'press_key'].map((n) => [`mastra_workspace_computer_${n}`, { screenshotDelayMs: 0 }]),
) as WorkspaceToolsConfig;
const COORDS = /\(\s*\d+\s*,\s*\d+\s*\)|\bx\s*[:=]\s*\d|\by\s*[:=]\s*\d/;

let vm: FakeVm;
let rows: ReturnType<typeof listRow>[];
/** The file on the VM's disk. */
let disk: string | null;
/** A simulated Mousepad window (null: not open). */
let gui: { buffer: string; caret: number; openDialog: string | null } | null;
let windowSurvivesPause: boolean;
/**
 * Simulated per-call latency of desktop input. Unequal delays make concurrent
 * calls finish out of order, as separate HTTP requests to the VM can.
 */
let latency: { write: number; press: number };
/** Return presses the simulated editor drops (1-based), to model lost input. */
let dropReturns: number[];
const pause = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** The text a model sees in a prompt: string contents and text parts, without per-part metadata. */
function promptText(prompt: unknown): string {
  const messages = prompt as { content: string | { type: string; text?: string }[] }[];
  return messages
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((p) => p.text ?? '')))
    .join('\n');
}

const desk = () =>
  vm.desktop as unknown as {
    click: Mock<(...args: unknown[]) => Promise<void>>;
    write: Mock<(text: string) => Promise<void>>;
    press: Mock<(keys: string[]) => Promise<void>>;
  };

const call = (toolName: string, input: Record<string, unknown> = {}): ScriptedStep => ({
  toolCalls: [{ toolName: `mastra_workspace_${toolName}`, input }],
});
const key = (k: string) => call('computer_press_key', { key: k });
const type = (text: string) => call('computer_type', { text });

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-launch-1234567890');
  rows = [];
  disk = null;
  gui = null;
  windowSurvivesPause = true;
  latency = { write: 0, press: 0 };
  dropReturns = [];
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
    // A shell append (what Session 2 must not do).
    const append = command.match(/^echo '?([^'>]*)'? >> /);
    if (append && disk !== null) disk += `\n${append[1]}`;
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
  desk().write.mockImplementation(async (text) => {
    await pause(latency.write);
    insert(text);
  });
  let returns = 0;
  desk().press.mockImplementation(async (keys) => {
    await pause(latency.press);
    if (!gui) return;
    const combo = keys.join('+');
    if (combo === 'Return' && gui.openDialog === null && dropReturns.includes(++returns)) return;
    if (combo === 'ctrl+End') gui.caret = gui.buffer.length;
    else if (combo === 'ctrl+o') gui.openDialog = '';
    else if (combo === 'Return' && gui.openDialog !== null) {
      if (gui.openDialog === PATH && disk !== null) gui.buffer = disk;
      gui.caret = 0;
      gui.openDialog = null;
    } else if (combo === 'Return') insert('\n');
    else if (combo === 'ctrl+s') disk = gui.buffer;
  });
});

/** The prompts' typing rule: one type call per non-empty line, one Enter between lines. */
const typingCalls = (lines: string[]): ScriptedStep[] =>
  lines.flatMap((l, i) => [...(l === '' ? [] : [type(l)]), ...(i < lines.length - 1 ? [key('Enter')] : [])]);

/** All of a step list's tool calls in one model step, the way models usually batch them. */
const batch = (steps: ScriptedStep[]): ScriptedStep => ({
  toolCalls: steps.flatMap((s) => ('toolCalls' in s ? s.toolCalls : [])),
});

/** Session 1 as a model would do it: open Mousepad, type the brief, save, check. */
const session1 = (typing: ScriptedStep[] = [batch(typingCalls(DRAFT))]): ScriptedStep[] => [
  call('computer_screenshot'),
  call('computer_click', { x: 20, y: 10 }), // Applications → Mousepad
  call('computer_click', { x: 400, y: 300 }), // text area
  ...typing,
  key('ctrl+s'),
  call('execute_command', { command: `cat ${PATH}` }),
  { text: 'RESULT: saved' },
];

/** Session 2: append the COMPLETED section through the GUI, save, check. */
const appendSection = (total: number | string = TOTAL): ScriptedStep[] => [
  call('computer_click', { x: 400, y: 300 }),
  key('ctrl+End'),
  batch([key('Enter'), ...typingCalls(L.sectionLines(total))]),
  key('ctrl+s'),
  call('computer_screenshot'),
  call('execute_command', { command: `cat ${PATH}` }),
  { text: `RESULT: budget total ${total}` },
];
const SESSION2: ScriptedStep[] = [call('computer_screenshot'), call('execute_command', { command: `cat ${PATH}` }), ...appendSection()];

/** Mirrors examples/launch-demo.ts: start, runLaunchDemo, cleanup in `finally` (newest instance first). */
async function runDemo(s1: Model, s2: Model, opts: { beforeSession2?: () => Promise<void> } = {}) {
  const prompts1: unknown[] = [];
  const prompts2: unknown[] = [];
  const w = createDesktopWorkspace({ namePrefix: 'mastra-launch-demo' }, TOOLS);
  const lines: string[] = [];
  const shots: string[] = [];
  let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
  let ok = false;
  let error: unknown;
  let status = '';
  try {
    await w.sandbox.start();
    ok = await L.runLaunchDemo({
      sandbox: w.sandbox,
      workspace: w.workspace,
      editor: EDITOR,
      budget: BUDGET,
      models: {
        session1: scriptedModel(s1, { onPrompt: (p) => prompts1.push(p) }),
        session2: scriptedModel(s2, { onPrompt: (p) => prompts2.push(p) }),
      },
      maxSteps: { session1: 30, session2: 30 },
      timeoutMs: 30_000,
      tools: TOOLS,
      onRestored: (r) => (restored = r),
      beforeSession2: opts.beforeSession2,
      saveShot: (name) => shots.push(name),
      log: (l) => lines.push(...l.split('\n')),
      poll: FAST_POLL,
    });
  } catch (e) {
    error = e;
  } finally {
    status = await demo.destroyAndConfirm([...(restored ? [restored.workspace] : []), w.workspace], vm.id, w.sandbox.id, FAST_POLL);
  }
  return { ok, error, status, lines, shots, restored, w, prompts1, prompts2 };
}

function expectCleanedUp(r: Awaited<ReturnType<typeof runDemo>>) {
  expect(r.status).toBe('absent');
  expect(rows).toEqual([]);
  expect(r.w.sandbox.status).toBe('destroyed');
  if (r.restored) expect(r.restored.sandbox.status).toBe('destroyed');
  expect(sdk.create).toHaveBeenCalledTimes(1);
}

describe('launchConfig', () => {
  it('has bounded defaults', () => {
    expect(L.launchConfig({})).toEqual({
      model: 'openai/gpt-5.4-mini',
      s1MaxSteps: 38,
      s2MaxSteps: 30,
      viewer: false,
      viewerPort: 7777,
      setupEditor: false,
      editorLook: true,
    });
  });

  it('reads overrides', () => {
    const c = L.launchConfig({
      OPENAI_MODEL: 'openai/gpt-5.4',
      LAUNCH_S1_MAX_STEPS: '40',
      LAUNCH_S2_MAX_STEPS: '12',
      DEMO_VIEWER: '1',
      DEMO_VIEWER_PORT: '8080',
      DEMO_SETUP_EDITOR: 'true',
      LAUNCH_EDITOR_LOOK: '0',
    });
    expect(c).toEqual({ model: 'openai/gpt-5.4', s1MaxSteps: 40, s2MaxSteps: 12, viewer: true, viewerPort: 8080, setupEditor: true, editorLook: false });
  });

  it('rejects invalid values', () => {
    for (const v of ['0', '41', '2.5', 'many']) {
      expect(() => L.launchConfig({ LAUNCH_S1_MAX_STEPS: v })).toThrow('LAUNCH_S1_MAX_STEPS must be an integer from 1 to 40');
      expect(() => L.launchConfig({ LAUNCH_S2_MAX_STEPS: v })).toThrow('LAUNCH_S2_MAX_STEPS must be an integer from 1 to 40');
    }
    expect(() => L.launchConfig({ OPENAI_MODEL: 'anthropic/x' })).toThrow('OPENAI_MODEL must be an OpenAI model');
    expect(() => L.launchConfig({ DEMO_VIEWER: '1', DEMO_VIEWER_PORT: '80' })).toThrow('DEMO_VIEWER_PORT');
  });

  it('step budgets cover one tool call per step for the whole workflow', () => {
    const typing = (lines: string[]) => typingCalls(lines).length;
    // screenshot, 3 clicks to open Mousepad, text area, typing, ctrl+s, path, Enter, screenshot, cat, answer
    const s1 = 1 + 3 + 1 + typing(DRAFT) + 3 + 2 + 1;
    // screenshot, cat, text area, ctrl+End, Enter + typing, ctrl+s, screenshot, cat, answer; +6 to reopen the file
    const s2 = 4 + 1 + typing(L.sectionLines(TOTAL)) + 4 + 6;
    expect([typing(DRAFT), s1, s2]).toEqual([24, 35, 27]);
    expect(L.S1_MAX_STEPS_DEFAULT - s1).toBeGreaterThanOrEqual(3);
    expect(L.S2_MAX_STEPS_DEFAULT - s2).toBeGreaterThanOrEqual(3);
    expect(L.MAX_STEPS_LIMIT).toBeLessThanOrEqual(L.S1_MAX_STEPS_DEFAULT + 2);
  });
});

describe('the launch brief', () => {
  it('picks small round amounts', () => {
    expect(L.pickBudget(() => 0)).toEqual({ design: 300, hosting: 100, promotion: 200 });
    expect(L.pickBudget(() => 0.9999)).toEqual({ design: 500, hosting: 200, promotion: 300 });
    expect(L.budgetTotal(BUDGET)).toBe(TOTAL);
  });

  it('lays out the full document: rules, headings, aligned amounts, one blank line between blocks', () => {
    expect(FINAL_DOC).toBe(
      [
        'MASTRA x SUPERSERVE',
        'PROJECT LAUNCH BRIEF',
        '----------------------------------',
        '',
        'OVERVIEW',
        'Native computer-use integration for persistent AI agents.',
        '',
        'BUDGET',
        'Design       $400',
        'Hosting      $150',
        'Promotion    $250',
        '',
        '----------------------------------',
        'NEXT: Finalize budget and launch summary.',
        '',
        '----------------------------------',
        'SESSION 02 / COMPLETED',
        '',
        'TOTAL BUDGET   $800',
        'STATUS         READY FOR LAUNCH',
        '',
        'Budget reviewed. Launch summary complete.',
      ].join('\n'),
    );
  });

  it('stays printable ASCII and fits a maximized Mousepad at 1280x800, for every possible budget', () => {
    const lines = L.finalLines({ design: 500, hosting: 200, promotion: 300 });
    expect(lines.every((l) => /^[\x20-\x7e]*$/.test(l))).toBe(true);
    expect(lines.every((l) => l === l.trim())).toBe(true);
    expect(lines).toContain('TOTAL BUDGET   $1000');
    // Measured live at Mousepad's default 10 pt: 17 px per line, 8 px per
    // character, text area from y=83; the bottom dock starts at y=752.
    const scale = 16 / 10;
    expect(L.EDITOR_FONT).toBe('Monospace 16');
    expect(83 + lines.length * Math.ceil(17 * scale)).toBeLessThan(752);
    expect(8 + Math.max(...lines.map((l) => l.length)) * Math.ceil(8 * scale)).toBeLessThan(1280);
    // No double blank lines; values line up within each block.
    expect(lines.join('\n')).not.toContain('\n\n\n');
    expect(new Set(DRAFT.filter((l) => l.includes('$')).map((l) => l.indexOf('$'))).size).toBe(1);
    expect(L.totalLine(TOTAL).indexOf('$')).toBe(L.STATUS_LINE.indexOf('READY'));
  });

  it('Session 1 gets every line, blank lines spelled out, the typing rule and the GUI route, with no coordinates', () => {
    const p = L.session1Prompt(EDITOR, BUDGET);
    for (const line of DRAFT.filter(Boolean)) expect(p).toContain(`      ${line}\n`);
    expect(p.match(/^ {6}\(empty line\)$/gm)).toHaveLength(DRAFT.filter((l) => l === '').length);
    expect(p).toContain(`type these ${DRAFT.length} lines exactly`);
    expect(p).toContain('exactly the number of lines minus one');
    expect(p).toContain('never put a newline inside the text');
    expect(p).toContain(PATH);
    expect(p).toContain('Applications');
    expect(p).toContain('do not add up the budget');
    expect(p).not.toMatch(COORDS);
  });

  it('Session 2 gets the section layout but no amounts, no total and no Session 1 text, whatever the budget', () => {
    const p = L.session2Prompt(EDITOR);
    expect(p).toContain(PATH);
    for (const l of [L.RULE, L.SESSION2_HEADING, 'TOTAL BUDGET   $<total>', L.STATUS_LINE, L.SUMMARY_LINE]) expect(p).toContain(`      ${l}\n`);
    expect(p).toContain('ctrl+End');
    expect(p).toContain('Press Enter once');
    expect(p).toContain('NEXT:');
    expect(p).not.toMatch(/\b\d{3,}\b/); // every possible amount and total has 3+ digits
    for (const s of ['Design', 'Hosting', 'Promotion', 'OVERVIEW', 'Native computer-use', L.LAUNCH_TITLE, L.NEXT_LINE]) expect(p).not.toContain(s);
    expect(p).not.toMatch(COORDS);
  });
});

describe('checkDraft / checkFinal', () => {
  it('accepts the brief, ignoring what editors add on save', () => {
    expect(L.checkDraft(DRAFT_TEXT, BUDGET)).toEqual({ correct: true, textDiff: null, layoutExact: true, layoutDiff: null, leftForNext: true });
    // A final newline, trailing spaces and CRLF are not even layout.
    expect(L.checkDraft(`${DRAFT_TEXT.replace('BUDGET', 'BUDGET  ').replace(/\n/g, '\r\n')}\n`, BUDGET)).toMatchObject({ correct: true, layoutExact: true });
  });

  it('allows cosmetic whitespace (blank lines, column spacing, indentation) and notes where it differs', () => {
    const extraBlank = DRAFT_TEXT.replace(`${L.LAUNCH_TITLE}\n`, `${L.LAUNCH_TITLE}\n\n`);
    expect(L.checkDraft(extraBlank, BUDGET)).toMatchObject({
      correct: true,
      layoutExact: false,
      layoutDiff: 'line 2: expected "PROJECT LAUNCH BRIEF", found (empty line)',
    });
    const spacing = DRAFT_TEXT.replace('Design       $400', ' Design $400').replace('OVERVIEW\n', 'OVERVIEW\n\n').replace('\n\nBUDGET', '\nBUDGET');
    expect(L.checkDraft(spacing, BUDGET)).toMatchObject({ correct: true, layoutExact: false });
  });

  it('is strict about text: a lost line break, a wrong amount, a changed heading or rule, a missing or extra line', () => {
    const joined = DRAFT_TEXT.replace('$150\n', '$150');
    expect(L.checkDraft(joined, BUDGET)).toMatchObject({
      correct: false,
      textDiff: 'text line 8: expected "Hosting $150", found "Hosting $150Promotion $250"',
    });
    expect(L.checkDraft(DRAFT_TEXT.replace('$400', '$500'), BUDGET).correct).toBe(false);
    expect(L.checkDraft(DRAFT_TEXT.replace('$400', '$ 400'), BUDGET).correct).toBe(false);
    expect(L.checkDraft(DRAFT_TEXT.replace('Design', 'Desgn'), BUDGET).correct).toBe(false);
    expect(L.checkDraft(DRAFT_TEXT.replace('BUDGET', 'Budget'), BUDGET).correct).toBe(false);
    expect(L.checkDraft(DRAFT_TEXT.replace(L.RULE, L.RULE.slice(1)), BUDGET).correct).toBe(false);
    expect(L.checkDraft(DRAFT.slice(0, -1).join('\n'), BUDGET).textDiff).toBe(`text line 11: expected "${L.NEXT_LINE}", found (end of file)`);
    expect(L.checkDraft(`${DRAFT_TEXT}\nextra`, BUDGET).correct).toBe(false);
    // Swapped lines are out of order.
    expect(L.checkDraft(DRAFT_TEXT.replace(/^(Design.*)\n(Hosting.*)$/m, '$2\n$1'), BUDGET).correct).toBe(false);
  });

  it('flags work done early', () => {
    expect(L.checkDraft(`${DRAFT_TEXT}\n${L.totalLine(800)}`, BUDGET).leftForNext).toBe(false);
  });

  it('accepts one COMPLETED section with the right total after the brief', () => {
    expect(L.checkFinal(`${FINAL_DOC}\n`, BUDGET)).toEqual({
      draftKept: true,
      appended: true,
      total: TOTAL,
      expectedTotal: TOTAL,
      totalCorrect: true,
      completedOnce: true,
      correct: true,
      textDiff: null,
      layoutExact: true,
      layoutDiff: null,
    });
    // Cosmetic: one blank line too few before the section, single spaces in the table.
    const cramped = L.checkFinal(FINAL_DOC.replace(`${L.NEXT_LINE}\n\n`, `${L.NEXT_LINE}\n`).replace('TOTAL BUDGET   $800', 'TOTAL BUDGET $800'), BUDGET);
    expect(cramped).toMatchObject({ draftKept: true, appended: true, totalCorrect: true, correct: true, layoutExact: false });
    expect(cramped.layoutDiff).toBe(`line 15: expected (empty line), found "${L.RULE}"`);
  });

  it('flags a wrong total, a missing status, a duplicate section and a section before the brief', () => {
    const wrong = L.checkFinal(FINAL_DOC.replace('$800', '$750'), BUDGET);
    expect(wrong).toMatchObject({ total: 750, totalCorrect: false, correct: false });
    expect(wrong.textDiff).toBe('text line 14: expected "TOTAL BUDGET $800", found "TOTAL BUDGET $750"');
    // The total is still read with a comma.
    expect(L.checkFinal(FINAL_DOC.replace('TOTAL BUDGET   $800', 'TOTAL BUDGET $1,000'), { design: 500, hosting: 200, promotion: 300 }).total).toBe(1000);
    expect(L.checkFinal(FINAL_DOC.replace(`${L.STATUS_LINE}\n`, ''), BUDGET)).toMatchObject({ completedOnce: false, correct: false });
    const twice = `${FINAL_DOC}\n${L.sectionLines(TOTAL).join('\n')}`;
    expect(L.checkFinal(twice, BUDGET)).toMatchObject({ completedOnce: false, correct: false });
    const before = [...L.sectionLines(TOTAL).slice(1), ...DRAFT].join('\n');
    expect(L.checkFinal(before, BUDGET)).toMatchObject({ draftKept: false, appended: false, correct: false });
    expect(L.checkFinal(FINAL_DOC.replace('$250', '$300'), BUDGET)).toMatchObject({ draftKept: false, correct: false });
  });
});

describe("keyedText (replays a session's own type and Enter calls)", () => {
  const asCalls = (steps: ScriptedStep[]) =>
    steps.flatMap((s) => ('toolCalls' in s ? s.toolCalls : [])).map((c) => ({ toolName: c.toolName, args: c.input }));

  it('spells the brief from the title to ctrl+s, ignoring the app finder and the save dialog', () => {
    const calls = asCalls([type('mousepad'), key('Enter'), ...typingCalls(DRAFT), key('ctrl+s'), type(PATH), key('Return')]);
    expect(L.keyedText(calls, L.S1_STARTS_AT)).toBe(DRAFT_TEXT);
    expect(L.keyedMatches(L.keyedText(calls, L.S1_STARTS_AT), DRAFT)).toBe(true);
  });

  it('accepts Enter spellings, shows other keys, skips failed calls', () => {
    const calls = [
      ...asCalls([type(L.LAUNCH_TITLE), key('enter'), type('a'), key('Return'), type('b'), key('BackSpace')]),
      { toolName: 'mastra_workspace_computer_type', args: { text: 'lost' }, isError: true },
    ];
    expect(L.keyedText(calls, L.S1_STARTS_AT)).toBe(`${L.LAUNCH_TITLE}\na\nb<BackSpace>`);
    expect(L.keyedText(asCalls([type('other')]), L.S1_STARTS_AT)).toBeNull();
    expect(L.keyedMatches(null, DRAFT)).toBe(false);
  });

  it('matches like the file check: an extra Enter is cosmetic, a missing one is not', () => {
    const extra = typingCalls(DRAFT);
    extra.splice(1, 0, key('Enter'));
    expect(L.keyedMatches(L.keyedText(asCalls(extra), L.S1_STARTS_AT), DRAFT)).toBe(true);
    const missing = typingCalls(DRAFT).filter((_, i) => i !== 1);
    expect(L.keyedMatches(L.keyedText(asCalls(missing), L.S1_STARTS_AT), DRAFT)).toBe(false);
  });

  it("Session 2's text starts after ctrl+End, not at the ctrl+o path", () => {
    const calls = asCalls([key('ctrl+o'), type(PATH), key('Enter'), key('ctrl+End'), key('Enter'), ...typingCalls(L.sectionLines(TOTAL)), key('ctrl+s')]);
    expect(L.keyedText(calls, L.S2_STARTS_AT)).toBe(`\n${L.sectionLines(TOTAL).join('\n')}`);
  });
});

describe('text entry order (the cause of the misplaced newlines)', () => {
  /** One agent run typing the brief in a single batched step, with writes slower than key presses. */
  async function typeBatched(toolCallConcurrency?: number) {
    latency = { write: 5, press: 0 };
    const w = createDesktopWorkspace({ namePrefix: 'mastra-launch-demo' }, TOOLS);
    await w.sandbox.start();
    const agent = createDesktopAgent(w.workspace, scriptedModel([call('computer_click', { x: 400, y: 300 }), batch(typingCalls(DRAFT)), { text: 'done' }]));
    await agent.generate('type the brief', { maxSteps: 5, ...(toolCallConcurrency && { toolCallConcurrency }) });
    await w.workspace.destroy();
    return gui!.buffer;
  }

  it("Mastra's default runs a step's tool calls concurrently, so line breaks land out of order", async () => {
    const buffer = await typeBatched();
    expect(buffer).not.toBe(DRAFT_TEXT);
    expect(L.checkDraft(buffer, BUDGET).correct).toBe(false);
  });

  it('one call at a time keeps the order the model chose', async () => {
    expect(await typeBatched(1)).toBe(DRAFT_TEXT);
  });

  it('both sessions run with toolCallConcurrency: 1', async () => {
    const generate = vi.spyOn(Agent.prototype, 'generate');
    try {
      const r = await runDemo(session1(), SESSION2);
      expect(r.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(2);
      for (const [, options] of generate.mock.calls as unknown[][]) expect(options).toMatchObject({ toolCallConcurrency: 1 });
    } finally {
      generate.mockRestore();
    }
  });
});

describe('LAUNCH_TOOLS', () => {
  it('drops only the type tool’s post-action screenshot; clicks and keys keep theirs (and their wait)', () => {
    expect(L.LAUNCH_TOOLS).toEqual({ mastra_workspace_computer_type: { screenshotAfterAction: false } });
  });

  it('the type call returns no screenshot, the next key press does', async () => {
    const w = createDesktopWorkspace({ namePrefix: 'mastra-launch-demo' }, { ...L.LAUNCH_TOOLS, mastra_workspace_computer_press_key: { screenshotDelayMs: 0 } });
    await w.sandbox.start();
    const agent = createDesktopAgent(w.workspace, scriptedModel([call('computer_click', { x: 400, y: 300 }), type('a'), key('Enter'), { text: 'done' }]));
    const before = vm.desktop.screenshot.mock.calls.length;
    const r = await agent.generate('type', { maxSteps: 5, toolCallConcurrency: 1 });
    await w.workspace.destroy();
    expect(r.steps.length).toBe(4);
    // click (default delay 500 ms) and Enter take one each; type takes none.
    expect(vm.desktop.screenshot.mock.calls.length - before).toBe(2);
  });
});

describe('prepareEditorLook (best-effort display settings)', () => {
  it('reports only the settings that were read back', async () => {
    const lines: string[] = [];
    const executeCommand = vi.fn(async () => ({ stdout: 'mastra-look:bus=yes\nmastra-look:font=yes\nmastra-look:icons=yes\n', stderr: '', exitCode: 0 }));
    const look = await L.prepareEditorLook({ executeCommand } as never, (l) => lines.push(l));
    expect(look).toEqual({ font: true, maximized: false, icons: true });
    expect(executeCommand).toHaveBeenCalledWith('sh -c', [L.editorLookScript()], { timeout: 30_000 });
    expect(lines).toEqual(['[SETUP] Display settings: editor font Monospace 16, desktop icons hidden (not applied: maximized window)']);
  });

  it('never throws, and never starts Mousepad', async () => {
    const lines: string[] = [];
    const executeCommand = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    expect(await L.prepareEditorLook({ executeCommand } as never, (l) => lines.push(l))).toEqual({ font: false, maximized: false, icons: false });
    expect(lines[0]).toMatch(/^\[SETUP\] Display settings skipped: Error: fetch failed/);
    expect(L.editorLookScript()).not.toMatch(/(^|[;&|\s])mousepad(\s|$)/m);
  });
});

describe('runLaunchDemo', () => {
  it('Session 1 drafts, the VM pauses and reconnects, a fresh Session 2 completes it on the same VM', async () => {
    // Batched typing and slow writes: passes only because tool calls run one at a time.
    latency = { write: 3, press: 0 };
    const r = await runDemo(session1(), SESSION2);

    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(disk).toBe(FINAL_DOC);

    // One VM, paused once, reconnected once by a new provider instance.
    expect(vm.pause).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(r.restored!.sandbox).not.toBe(r.w.sandbox);
    expect(r.lines).toContain('  [ok] same sandbox for Session 1, reconnect and Session 2 (vm-launc)');
    expect(r.lines).toContain('[VM] Reconnected to same sandbox vm-launc (ownership: adopted)');
    expect(r.lines).toContain(`[VM] State preserved: ${PATH} still holds Session 1's brief`);

    // Banners in order, each naming the same sandbox.
    const banners = r.lines.filter((l) => /^ {2}(SESSION|PAUSE|RESULT)/.test(l));
    expect(banners).toEqual([
      '  SESSION 1 · Mastra agent A drafts the launch brief · sandbox vm-launc',
      '  PAUSE → RECONNECT · scripted Superserve lifecycle · sandbox vm-launc',
      '  SESSION 2 · fresh Mastra agent B, no memory · sandbox vm-launc',
      '  RESULT',
    ]);
    expect(r.lines.filter((l) => l.startsWith('  [FAIL]'))).toEqual([]);
    expect(r.lines).toContain('  [ok] total 800 = 400 + 150 + 250 = 800');
    expect(r.lines).toContain(`  [ok] ${PATH} holds the brief: headings, amounts and lines in order (read outside the agent)`);
    expect(r.lines).toContain(`  [ok] ${PATH} holds the brief, then the section: headings, amounts and lines in order`);
    expect(r.lines.filter((l) => l.includes('note:'))).toEqual([]);
    expect(r.shots).toEqual(['launch-1-session-1', 'launch-2-after-reconnect', 'launch-3-session-2']);

    // Session 2's first model call carries nothing from Session 1: one user message, no amounts.
    // Only the message text is checked: Mastra adds per-part metadata such as an epoch-ms
    // `createdAt`, whose digits can contain "250" or "800" by chance.
    const first = promptText(r.prompts2[0]);
    expect(first).toContain(PATH);
    for (const s of ['400', '150', '250', '800', 'Design', 'OVERVIEW', L.LAUNCH_TITLE, L.NEXT_LINE, 'RESULT: saved']) expect(first).not.toContain(s);
    expect((r.prompts2[0] as { role: string }[]).filter((m) => m.role === 'user')).toHaveLength(1);
    // Typed text is never logged.
    expect(r.lines.join('\n')).not.toContain('Native computer-use');
    expect(r.lines.join('\n')).not.toContain(L.SUMMARY_LINE);
    expectCleanedUp(r);
  });

  it('also passes when the model makes one call per step', async () => {
    const r = await runDemo(session1(typingCalls(DRAFT)), SESSION2);
    expect(r.ok).toBe(true);
    expect(disk).toBe(FINAL_DOC);
    expectCleanedUp(r);
  });

  it('reopens the file through the GUI when the editor window did not survive the pause', async () => {
    windowSurvivesPause = false;
    const reopen: ScriptedStep[] = [
      call('computer_screenshot'),
      call('computer_click', { x: 20, y: 10 }), // Applications → Mousepad
      key('ctrl+o'),
      type(PATH),
      key('Enter'),
      ...appendSection(),
    ];
    const r = await runDemo(session1(), reopen);
    expect(r.ok).toBe(true);
    expect(disk).toBe(FINAL_DOC);
    expectCleanedUp(r);
  });

  it('fails when Session 2 writes a wrong total', async () => {
    const r = await runDemo(session1(), [call('computer_screenshot'), ...appendSection(750)]);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain('  [FAIL] total 750 = 400 + 150 + 250 = 800');
    expect(r.lines).toContain('  [FAIL] Session 2 reported the total');
    expect(r.lines).toContain('[S2] text differs at text line 14: expected "TOTAL BUDGET $800", found "TOTAL BUDGET $750"');
    expectCleanedUp(r);
  });

  it('fails when Session 2 appends through the shell instead of the GUI', async () => {
    const viaShell: ScriptedStep[] = [
      call('computer_screenshot'),
      call('execute_command', { command: `echo '${L.SESSION2_HEADING}' >> ${PATH}` }),
      { text: `RESULT: budget total ${TOTAL}` },
    ];
    const r = await runDemo(session1(), viaShell);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain('  [FAIL] Session 2 did not modify the file from the shell');
    expect(r.lines).toContain('  [FAIL] Session 2 clicked on the desktop');
    expectCleanedUp(r);
  });

  it('stops after a failed Session 1: no pause, no reconnect, no Session 2 model call', async () => {
    const r = await runDemo(session1([batch(typingCalls(DRAFT.slice(0, -2)))]), SESSION2);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain(`  [FAIL] ${PATH} holds the brief: headings, amounts and lines in order (read outside the agent)`);
    expect(r.lines.at(-1)).toBe('[S1] FAIL: see the failed checks above (VM not paused, no Session 2)');
    expect(vm.pause).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(r.prompts2).toEqual([]);
    expectCleanedUp(r);
  });

  it('passes with a note when the model presses an extra Enter after the title (cosmetic)', async () => {
    const extraEnter = typingCalls(DRAFT);
    extraEnter.splice(1, 0, key('Enter'));
    const r = await runDemo(session1([batch(extraEnter)]), SESSION2);
    expect(r.ok).toBe(true);
    expect(r.lines).toContain("  [ok] Session 1's type and Enter calls spell the brief");
    expect(r.lines).toContain('[S1] note: cosmetic whitespace differs at line 2: expected "PROJECT LAUNCH BRIEF", found (empty line) (allowed)');
    expect(r.lines).toContain('[S2] note: cosmetic whitespace differs at line 2: expected "PROJECT LAUNCH BRIEF", found (empty line) (allowed)');
    expectCleanedUp(r);
  });

  it('fails Session 1 when the model skips the Enter between two budget lines, and says the calls were wrong', async () => {
    const calls = typingCalls(DRAFT);
    const at = calls.findIndex((s) => 'toolCalls' in s && s.toolCalls[0]!.input.text === DRAFT[9]);
    calls.splice(at + 1, 1);
    const r = await runDemo(session1([batch(calls)]), SESSION2);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain("  [FAIL] Session 1's type and Enter calls spell the brief");
    expect(r.lines).toContain('[S1] text differs at text line 8: expected "Hosting $150", found "Hosting $150Promotion $250"');
    expect(r.lines).toContain("[S1] the agent's type and Enter calls do not spell the expected text: the model typed it differently");
    expect(vm.pause).not.toHaveBeenCalled();
    expect(r.prompts2).toEqual([]);
    expectCleanedUp(r);
  });

  it('tells lost input apart from a model mistake (right calls, wrong file)', async () => {
    dropReturns = [10]; // the Enter after the Hosting line
    const r = await runDemo(session1(), SESSION2);
    expect(r.ok).toBe(false);
    expect(r.lines).toContain("  [ok] Session 1's type and Enter calls spell the brief");
    expect(r.lines).toContain('[S1] text differs at text line 8: expected "Hosting $150", found "Hosting $150Promotion $250"');
    expect(r.lines).toContain("[S1] the agent's type and Enter calls spell the expected text: the input reached the editor differently");
    expect(vm.pause).not.toHaveBeenCalled();
    expectCleanedUp(r);
  });

  it('stops before Session 2 when Superserve lists a replacement VM', async () => {
    sdk.connect.mockImplementation(async (id: string) => {
      for (const r of rows) if (r.id === id) r.status = 'active';
      rows.push(listRow('vm-replacement-0001', rows[0]!.metadata, 'active'));
      return vm;
    });
    const r = await runDemo(session1(), SESSION2);
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toMatch(/^\[VM\] FAILED: replacement VM check/);
    expect(r.prompts2).toEqual([]);
  });

  it('runs beforeSession2 after the reconnect and before Session 2', async () => {
    const order: string[] = [];
    const r = await runDemo(session1(), SESSION2, {
      beforeSession2: async () => {
        order.push(`hook (connects: ${sdk.connect.mock.calls.length})`);
      },
    });
    expect(r.ok).toBe(true);
    expect(order).toEqual(['hook (connects: 1)']);
    expect(r.lines.findIndex((l) => l.includes('SESSION 2 ·'))).toBeGreaterThan(r.lines.findIndex((l) => l.startsWith('[VM] One VM')));
  });

  it('propagates a Session 2 model failure, and cleanup still destroys the VM', async () => {
    const failing = scriptedModel([]);
    failing.doGenerate = async () => {
      throw new Error('model unavailable');
    };
    failing.doStream = failing.doGenerate as never;
    const prompts1: unknown[] = [];
    const w = createDesktopWorkspace({ namePrefix: 'mastra-launch-demo' }, TOOLS);
    let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
    await w.sandbox.start();
    await expect(
      L.runLaunchDemo({
        sandbox: w.sandbox,
        workspace: w.workspace,
        editor: EDITOR,
        budget: BUDGET,
        models: { session1: scriptedModel(session1(), { onPrompt: (p) => prompts1.push(p) }), session2: failing },
        maxSteps: { session1: 30, session2: 30 },
        timeoutMs: 30_000,
        tools: TOOLS,
        onRestored: (r) => (restored = r),
        log: () => {},
        poll: FAST_POLL,
      }),
    ).rejects.toThrow();
    expect(restored).toBeDefined();
    const status = await demo.destroyAndConfirm([restored!.workspace, w.workspace], vm.id, w.sandbox.id, FAST_POLL);
    expect(status).toBe('absent');
    expect(rows).toEqual([]);
  });
});

describe('examples/launch-demo.ts entry point (no keys, no network)', () => {
  const script = fileURLToPath(new URL('../examples/launch-demo.ts', import.meta.url));
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

  it('skips without keys', async () => {
    const { code, out } = await run({});
    expect(out).toContain('Skipping: set SUPERSERVE_API_KEY and OPENAI_API_KEY');
    expect(code).toBe(0);
  }, 30_000);

  it('rejects an invalid step budget before doing anything', async () => {
    const { code, out } = await run({ LAUNCH_S2_MAX_STEPS: '99' });
    expect(out).toContain('LAUNCH_S2_MAX_STEPS must be an integer from 1 to 40');
    expect(code).toBe(1);
  }, 30_000);
});
