/**
 * The launch-brief demo (`pnpm example:launch`, see docs/LAUNCH-DEMO.md):
 * two independent Mastra agent invocations on one Superserve VM, with a
 * pause and a reconnect by `sandboxId` in between.
 *
 * - Session 1 opens Mousepad through the desktop and types a short launch
 *   brief (`draftLines`): title, overview, three budget amounts and a "NEXT:"
 *   handoff line, separated by ASCII rules and blank lines, then saves.
 * - The scripted lifecycle (`showcasePersistence`) pauses the VM and attaches
 *   a new `SuperserveSandbox` built from the saved `sandboxId`.
 * - Session 2 is a new `Agent` with no memory. Its prompt names only the file
 *   and the section to append: not the budget amounts, nor anything Session 1
 *   said or did. It must read the amounts from the document, add them up, and
 *   append the "SESSION 02 / COMPLETED" section (`sectionLines`) through the GUI.
 * - Independent checks (outside the agents, read-only) confirm the GUI was
 *   used, the file was not edited through the shell, the file's text matches
 *   line for line (headings, rules, amounts and their order; blank lines and
 *   column spacing are cosmetic and only noted), the total is the sum of the
 *   amounts in the file and the same VM was used throughout.
 *
 * Text entry: one type-tool call per non-empty line and one Enter key press
 * between lines. Each agent run sets `toolCallConcurrency: 1`, because Mastra
 * runs the tool calls of one model step concurrently by default (limit 10)
 * and the desktop calls then reach the VM in arbitrary order: an earlier live
 * run got an extra newline after the title and lost one between two budget
 * lines that way. Edits are append-only (ctrl+End, Enter, type); nothing is
 * edited in place.
 */
import type { Agent } from '@mastra/core/agent';
import type { Workspace, WorkspaceToolsConfig } from '@mastra/core/workspace';
import { normalizeKey, type SuperserveSandbox, type SuperserveSandboxOptions } from '../src/index.js';
import { listVmIds, type SessionCall, shellModifies, shellSendsInput } from './continue-session.js';
import { createToolCallLogger, type Log, shortId, showcasePersistence } from './demo.js';
import { createDesktopAgent } from './desktop-agent.js';
import { describeError, type GuiEditor, shellLaunches } from './editor-task.js';

/** In the desktop user's home (`/home/desktop`, the default user for commands too). */
export const LAUNCH_DOC_PATH = '/home/desktop/launch-brief.txt';

// The document, plain ASCII only (`—`, `×` and box-drawing characters are
// left out: they depend on the keyboard path and the editor font).
export const LAUNCH_TITLE = 'MASTRA x SUPERSERVE';
export const LAUNCH_SUBTITLE = 'PROJECT LAUNCH BRIEF';
export const RULE = '-'.repeat(34);
export const NEXT_LINE = 'NEXT: Finalize budget and launch summary.';
export const SESSION2_HEADING = 'SESSION 02 / COMPLETED';
export const TOTAL_LABEL = 'TOTAL BUDGET';
export const STATUS_LINE = 'STATUS         READY FOR LAUNCH';
export const SUMMARY_LINE = 'Budget reviewed. Launch summary complete.';
/** Budget and section labels are padded to these widths so the values line up. */
const BUDGET_LABEL_WIDTH = 13;
const SECTION_LABEL_WIDTH = 15;

// ---------------------------------------------------------------- config

// Budgets assume the worst case seen with the fallback demo, about one tool
// call per step (models often batch, which only uses fewer steps).
// Session 1: screenshot, ~3 clicks to open Mousepad, text area, 24 typing
// calls (11 lines of text, 13 Enters), ctrl+s, path, Enter, screenshot, cat,
// answer = 35, plus a few for a misclick or an extra screenshot.
// Session 2: screenshot, cat, text area, ctrl+End, 13 typing calls, ctrl+s,
// screenshot, cat, answer = 21; reopening the file through the GUI after the
// pause adds ~6 = 27, plus a few.
export const S1_MAX_STEPS_DEFAULT = 38;
export const S2_MAX_STEPS_DEFAULT = 30;
export const MAX_STEPS_LIMIT = 40;

export interface LaunchConfig {
  /** Mastra model router id, `openai/<model>`. */
  model: string;
  s1MaxSteps: number;
  s2MaxSteps: number;
  viewer: boolean;
  viewerPort: number;
  setupEditor: boolean;
  /** Best-effort larger editor font and less desktop clutter (`prepareEditorLook`). */
  editorLook: boolean;
}

/** Read the demo's environment. Throws with a user-facing message on invalid values. */
export function launchConfig(env: Record<string, string | undefined>): LaunchConfig {
  const flag = (name: string) => env[name] === '1' || env[name] === 'true';
  const rawModel = env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
  if (rawModel.includes('/') && !rawModel.startsWith('openai/')) {
    throw new Error(`OPENAI_MODEL must be an OpenAI model (e.g. gpt-5.4-mini), got ${JSON.stringify(rawModel)}.`);
  }
  const steps = (name: string, fallback: number) => {
    const raw = env[name];
    const n = Number(raw ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS_LIMIT) {
      throw new Error(`${name} must be an integer from 1 to ${MAX_STEPS_LIMIT}, got ${JSON.stringify(raw)}.`);
    }
    return n;
  };
  const viewerPort = Number(env.DEMO_VIEWER_PORT ?? 7777);
  const viewer = flag('DEMO_VIEWER');
  if (viewer && (!Number.isInteger(viewerPort) || viewerPort < 1024 || viewerPort > 65535)) {
    throw new Error(`DEMO_VIEWER_PORT must be an integer from 1024 to 65535, got ${JSON.stringify(env.DEMO_VIEWER_PORT)}.`);
  }
  return {
    model: rawModel.startsWith('openai/') ? rawModel : `openai/${rawModel}`,
    s1MaxSteps: steps('LAUNCH_S1_MAX_STEPS', S1_MAX_STEPS_DEFAULT),
    s2MaxSteps: steps('LAUNCH_S2_MAX_STEPS', S2_MAX_STEPS_DEFAULT),
    viewer,
    viewerPort,
    setupEditor: flag('DEMO_SETUP_EDITOR'),
    editorLook: env.LAUNCH_EDITOR_LOOK !== '0' && env.LAUNCH_EDITOR_LOOK !== 'false',
  };
}

// ---------------------------------------------------------------- budget

export interface Budget {
  design: number;
  hosting: number;
  promotion: number;
}

const BUDGET_CHOICES: { [K in keyof Budget]: readonly number[] } = {
  design: [300, 400, 500],
  hosting: [100, 150, 200],
  promotion: [200, 250, 300],
};

/** Small round amounts, picked per run so the total cannot be known in advance. */
export function pickBudget(rand: () => number = Math.random): Budget {
  const pick = (xs: readonly number[]) => xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))]!;
  return { design: pick(BUDGET_CHOICES.design), hosting: pick(BUDGET_CHOICES.hosting), promotion: pick(BUDGET_CHOICES.promotion) };
}

export const budgetTotal = (b: Budget) => b.design + b.hosting + b.promotion;

const budgetLine = (label: string, amount: number) => `${label.padEnd(BUDGET_LABEL_WIDTH)}$${amount}`;
export const totalLine = (total: number | string) => `${TOTAL_LABEL.padEnd(SECTION_LABEL_WIDTH)}$${total}`;

/** The brief Session 1 types, line by line; `''` is a blank line. */
export function draftLines(b: Budget): string[] {
  return [
    LAUNCH_TITLE,
    LAUNCH_SUBTITLE,
    RULE,
    '',
    'OVERVIEW',
    'Native computer-use integration for persistent AI agents.',
    '',
    'BUDGET',
    budgetLine('Design', b.design),
    budgetLine('Hosting', b.hosting),
    budgetLine('Promotion', b.promotion),
    '',
    RULE,
    NEXT_LINE,
  ];
}

/**
 * The section Session 2 appends after pressing Enter at the end of the NEXT
 * line; `''` is a blank line. Starts with one, so the rule stands apart.
 */
export function sectionLines(total: number | string): string[] {
  return ['', RULE, SESSION2_HEADING, '', totalLine(total), STATUS_LINE, '', SUMMARY_LINE];
}

/** The whole document after Session 2. */
export const finalLines = (b: Budget) => [...draftLines(b), ...sectionLines(budgetTotal(b))];

// ---------------------------------------------------------------- prompts

const BLANK_MARK = '(empty line)';

/** Lines for a prompt, indented, with blank lines spelled out so none is lost. */
const promptBlock = (lines: string[]) => lines.map((l) => `      ${l === '' ? BLANK_MARK : l}`);

/** The typing rule both sessions follow (the checks replay exactly this). */
const TYPING_RULE = [
  '   Go through the lines top to bottom. For a line with text, type the whole line (spaces included) with',
  '   one type-tool call; never put a newline inside the text. After every line except the last, press Enter',
  `   with the key tool. For ${BLANK_MARK}, type nothing: just press Enter. So the number of Enter presses is`,
  '   exactly the number of lines minus one. Make these calls in the listed order.',
];

/** Session 1's task. Names the editor and the lines; every click and key is the model's. */
export function session1Prompt(editor: GuiEditor, budget: Budget, path = LAUNCH_DOC_PATH): string {
  const lines = draftLines(budget);
  return [
    `Task on the Linux (XFCE) desktop: write a short launch brief in the ${editor.name} text editor and save it.`,
    '1. Take a screenshot to see the desktop.',
    `2. Open ${editor.name} through the desktop: the "Applications" menu at the top left, or the application`,
    '   finder (magnifier icon in the bottom dock). Do not open it from a terminal or with execute_command.',
    `3. Click in the editor's text area so it has focus. Then type these ${lines.length} lines exactly:`,
    ...promptBlock(lines),
    ...TYPING_RULE,
    '   The NEXT line is a handoff for a later session: do not add up the budget and do not write a summary.',
    '4. Save with ctrl+s. In the save dialog, type the full path into the file name field and press Enter:',
    `   ${path}`,
    '   Take a screenshot to confirm the save worked.',
    `5. Check with execute_command: cat ${path}`,
    '   Compare it with the lines above, blank lines included.',
    'Do not create, modify or open the file with execute_command; use it only for that check.',
    'Finish with one line: "RESULT: saved" or "FAILED: <reason>".',
  ].join('\n');
}

/**
 * Session 2's task. Names the file and the section layout, but carries no
 * amounts, total or text from Session 1: the model has to read the document.
 */
export function session2Prompt(editor: GuiEditor, path = LAUNCH_DOC_PATH): string {
  const file = path.split('/').pop();
  return [
    'Task on the Linux (XFCE) desktop. An earlier session left a launch brief at:',
    `   ${path}`,
    `Its last line starts with "NEXT:". Do that work and record it with the ${editor.name} text editor, through the desktop.`,
    '1. Take a screenshot to see the desktop.',
    `2. If a ${editor.name} window with that file is already open (its title shows ${file}), use that window.`,
    `   Otherwise open ${editor.name} through the desktop (the "Applications" menu at the top left, or the`,
    '   application finder in the bottom dock), press ctrl+o, type the full path above into the file name field',
    '   and press Enter. Do not open the editor or the file from a terminal or with execute_command.',
    `3. Read the brief (on screen, or with execute_command: cat ${path}) and add up the budget amounts it`,
    '   lists yourself. That sum is the total.',
    "4. Click in the editor's text area so it has focus, then press ctrl+End with the key tool to move to the end",
    '   of the NEXT line. Keep the existing text: do not select, replace or delete anything.',
    '5. Press Enter once with the key tool to end the NEXT line. Then type these lines, with your total in',
    '   place of <total> (digits only, no comma):',
    ...promptBlock(sectionLines('<total>')),
    ...TYPING_RULE,
    '6. Save with ctrl+s (same file; if asked whether to overwrite, confirm). Take a screenshot to confirm the save.',
    `7. Check with execute_command: cat ${path}`,
    'Do not create or modify the file with execute_command.',
    'Finish with one line: "RESULT: budget total <total>" or "FAILED: <reason>".',
  ].join('\n');
}

// ---------------------------------------------------------------- checks

/**
 * The file as lines: `\r`, trailing spaces and newlines at the end of the
 * file (what an editor may add on save) removed.
 */
export const fileLines = (contents: string) =>
  contents
    .replace(/\r/g, '')
    .replace(/\n+$/, '')
    .split('\n')
    .map((l) => l.trimEnd());

/**
 * What the document says, without its cosmetic whitespace: the non-blank
 * lines, trimmed, with runs of spaces collapsed to one. Headings, rules,
 * labels, amounts and their order all still count, and so does a line break
 * (two lines run together are a different line).
 */
export const contentLines = (lines: string[]) => lines.map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '');

/** The first line where `actual` differs from `expected` (1-based), or null when they match. */
export function firstDifference(expected: string[], actual: string[], unit = 'line'): string | null {
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    if (expected[i] !== actual[i]) {
      const show = (l: string | undefined) => (l === undefined ? '(end of file)' : l === '' ? '(empty line)' : JSON.stringify(l));
      return `${unit} ${i + 1}: expected ${show(expected[i])}, found ${show(actual[i])}`;
    }
  }
  return null;
}

/** Strict text comparison (`contentLines`) and cosmetic layout comparison of a file against the expected lines. */
function compare(expected: string[], lines: string[]) {
  const textDiff = firstDifference(contentLines(expected), contentLines(lines), 'text line');
  const layoutDiff = firstDifference(expected, lines);
  return {
    /** Every heading, rule, label and amount, in order, nothing extra. Must pass. */
    correct: textDiff === null,
    textDiff,
    /** Blank lines and column spacing as designed. Reported, not required. */
    layoutExact: layoutDiff === null,
    layoutDiff,
  };
}

const isHeading = (l: string) => /^SESSION\s+0?2\b/i.test(l.trim());
const isTotal = (l: string) => /^TOTAL\s+BUDGET\b/i.test(l.trim());
const isStatus = (l: string) => /^STATUS\b/i.test(l.trim());
/** The amount on a TOTAL BUDGET line, tolerating `$` spacing and thousands commas. */
const totalOf = (l: string): number | null => {
  const m = l.trim().match(/^TOTAL\s+BUDGET\s*:?\s*\$?\s*([\d,]+)$/i);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
};

/** What the independent check found after Session 1. */
export function checkDraft(contents: string, budget: Budget) {
  const lines = fileLines(contents);
  return {
    ...compare(draftLines(budget), lines),
    /** The NEXT work was left for Session 2. */
    leftForNext: !lines.some((l) => isHeading(l) || isTotal(l) || isStatus(l)),
  };
}

/** What the independent check found after Session 2. */
export function checkFinal(contents: string, budget: Budget) {
  const lines = fileLines(contents);
  const text = contentLines(lines);
  const draft = contentLines(draftLines(budget));
  const draftKept = draft.every((l, i) => text[i] === l);
  const totalAt = lines.findIndex(isTotal);
  const total = totalAt >= 0 ? totalOf(lines[totalAt]!) : null;
  const expectedTotal = budgetTotal(budget);
  return {
    /** Session 1's text is unchanged at the top of the file. */
    draftKept,
    /** The Session 2 heading comes after all of Session 1's text. */
    appended: draftKept && text.findIndex(isHeading) >= draft.length,
    total,
    expectedTotal,
    totalCorrect: total === expectedTotal,
    /** One completed section: one heading, one total, one status. */
    completedOnce: [isHeading, isTotal, isStatus].every((is) => lines.filter(is).length === 1),
    /** `correct`: the whole document's text, in order, with the correct total. */
    ...compare(finalLines(budget), lines),
  };
}

/** Whether replayed keystrokes (`keyedText`) spell `expected`, ignoring cosmetic whitespace like the file check. */
export const keyedMatches = (keyed: string | null, expected: string[]) =>
  keyed !== null && firstDifference(contentLines(expected), contentLines(keyed.split('\n'))) === null;

/** A key press as `normalizeKey` sends it (`Enter` → `Return`, `ctrl+S` → `ctrl+s`); null if invalid. */
function keyCombo(key: unknown): string | null {
  try {
    return normalizeKey(key as string | string[]).join('+');
  } catch {
    return null;
  }
}

/**
 * The text a session's own type and Enter calls spell, replayed in call
 * order: from the first call `startsAt` accepts up to the next ctrl+s. Other
 * keys show up as `<key>` so they never match. Null if recording never
 * started. Comparing this with the file tells a model mistake (wrong calls)
 * apart from input that reached the editor differently (right calls, wrong file).
 */
export function keyedText(calls: SessionCall[], startsAt: (c: { type?: string; key?: string }) => boolean): string | null {
  let out: string | null = null;
  for (const c of calls) {
    if (c.isError) continue;
    const args = (c.args ?? {}) as { text?: unknown; key?: unknown };
    if (c.toolName?.endsWith('computer_type')) {
      const text = String(args.text ?? '');
      if (out === null && startsAt({ type: text })) out = '';
      if (out !== null) out += text;
    } else if (c.toolName?.endsWith('computer_press_key')) {
      const key = keyCombo(args.key) ?? String(args.key);
      if (out === null) {
        if (startsAt({ key })) out = '';
      } else if (key === 'ctrl+s') break;
      else out += key === 'Return' || key === 'KP_Enter' ? '\n' : `<${key}>`;
    }
  }
  return out;
}

/** What a session's tool calls show about how it worked. */
export function reviewCalls(calls: SessionCall[], o: { target: string; editorBin: string }) {
  const ok = calls.filter((c) => !c.isError);
  const used = (suffix: string) => ok.some((c) => c.toolName?.endsWith(suffix));
  const shell = calls
    .filter((c) => c.toolName?.endsWith('execute_command'))
    .map((c) => String((c.args as { command?: unknown } | undefined)?.command ?? ''));
  return {
    screenshot: used('computer_screenshot'),
    clicked: used('computer_click') || used('computer_double_click'),
    pressedKey: used('computer_press_key'),
    shellCommands: shell.length,
    shellModified: shell.some((cmd) => shellModifies(cmd, o.target)),
    shellLaunched: shell.some((cmd) => shellLaunches(cmd, o.editorBin)),
    shellInput: shell.some(shellSendsInput),
  };
}

/** Session 1 starts typing the brief with its title. */
export const S1_STARTS_AT = (c: { type?: string }) => c.type === LAUNCH_TITLE;
/** Session 2 starts typing after ctrl+End (an earlier ctrl+o path entry is not part of it). */
export const S2_STARTS_AT = (c: { key?: string }) => c.key === 'ctrl+End';

// ---------------------------------------------------------------- recording polish

/**
 * Fits the whole finished brief (22 lines, at most 57 characters) in a
 * maximized Mousepad at 1280x800: about 27 px per line and 13 px per
 * character, scaled from a live screenshot at the default 10 pt font (17 px
 * and 8 px). 18 pt would run into the bottom dock.
 */
export const EDITOR_FONT = 'Monospace 16';
const LOOK_MARK = 'mastra-look:';

/**
 * Shell script for `prepareEditorLook`. Finds the XFCE session's D-Bus
 * address (gsettings and xfconf write through it), then sets Mousepad's font
 * and maximized window state and hides desktop icons. Each setting is read
 * back in a new process and reported only if it stuck.
 */
export function editorLookScript(font = EDITOR_FONT): string {
  const m = LOOK_MARK;
  const view = 'org.xfce.mousepad.preferences.view';
  const win = 'org.xfce.mousepad.state.window';
  return [
    `for p in $(pgrep -u "$(id -u)" -x 'xfce4-session|xfwm4|xfce4-panel|xfdesktop'); do`,
    `  a=$(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')`,
    '  [ -n "$a" ] && break',
    'done',
    `[ -n "$a" ] && export DBUS_SESSION_BUS_ADDRESS="$a" && echo "${m}bus=yes"`,
    `gsettings set ${view} use-default-font false 2>/dev/null; gsettings set ${view} font-name '${font}' 2>/dev/null`,
    `[ "$(gsettings get ${view} font-name 2>/dev/null)" = "'${font}'" ] && [ "$(gsettings get ${view} use-default-font 2>/dev/null)" = false ] && echo "${m}font=yes"`,
    `gsettings set ${win} maximized true 2>/dev/null`,
    `[ "$(gsettings get ${win} maximized 2>/dev/null)" = true ] && echo "${m}maximized=yes"`,
    'if command -v xfconf-query >/dev/null 2>&1; then',
    '  xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 0 2>/dev/null',
    `  [ "$(xfconf-query -c xfce4-desktop -p /desktop-icons/style 2>/dev/null)" = 0 ] && echo "${m}icons=yes"`,
    'fi',
    'true',
  ].join('\n');
}

export interface EditorLook {
  font: boolean;
  maximized: boolean;
  icons: boolean;
}

/**
 * Recording polish, run by the script before any agent and never by the
 * model: a larger Mousepad font, a maximized Mousepad window and no desktop
 * icons. Settings only; Mousepad is not started. Best-effort: never throws,
 * and a setting that did not stick is logged and skipped.
 */
export async function prepareEditorLook(sandbox: Pick<SuperserveSandbox, 'executeCommand'>, log: Log, font = EDITOR_FONT): Promise<EditorLook> {
  const none: EditorLook = { font: false, maximized: false, icons: false };
  try {
    const { stdout } = await sandbox.executeCommand('sh -c', [editorLookScript(font)], { timeout: 30_000 });
    const has = (key: string) => new RegExp(`^${LOOK_MARK}${key}=yes$`, 'm').test(stdout);
    const look = { font: has('font'), maximized: has('maximized'), icons: has('icons') };
    const applied = [look.font && `editor font ${font}`, look.maximized && 'maximized editor window', look.icons && 'desktop icons hidden'];
    const skipped = [!look.font && 'font', !look.maximized && 'maximized window', !look.icons && 'desktop icons'];
    const a = applied.filter(Boolean).join(', ');
    const s = skipped.filter(Boolean).join(', ');
    log(`[SETUP] Display settings: ${a || 'none applied'}${s ? ` (not applied: ${s}${has('bus') ? '' : '; no desktop session bus found'})` : ''}`);
    return look;
  } catch (error) {
    log(`[SETUP] Display settings skipped: ${describeError(error)}`);
    return none;
  }
}

/** A section banner for the terminal half of the recording. */
export function banner(title: string): string {
  const rule = '━'.repeat(64);
  return `\n${rule}\n  ${title}\n${rule}`;
}

// ---------------------------------------------------------------- orchestration

type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];
type ToolStep = { toolResults: { payload?: SessionCall }[] };
type GenerateResult = Awaited<ReturnType<Agent['generate']>>;

export interface LaunchDemoOptions {
  /** The started sandbox and its workspace (Session 1 runs here). */
  sandbox: SuperserveSandbox;
  workspace: Workspace;
  editor: GuiEditor;
  budget: Budget;
  target?: string;
  /** One model per session; each session gets a new `Agent` with no memory. */
  models: { session1: AgentModel; session2: AgentModel };
  maxSteps: { session1: number; session2: number };
  /** Wall-time limit for each agent run. */
  timeoutMs: number;
  sandboxOptions?: SuperserveSandboxOptions;
  tools?: WorkspaceToolsConfig;
  /** Hand the reconnected instance to the caller's cleanup (called before it attaches). */
  onRestored: (restored: { sandbox: SuperserveSandbox; workspace: Workspace }) => void;
  /** Runs after the reconnect checks, before Session 2's agent (e.g. wait for the viewer). */
  beforeSession2?: () => Promise<void>;
  saveShot?: (name: string, png: Uint8Array) => void;
  onPhase?: (phase: string) => void;
  log: Log;
  poll?: { attempts?: number; intervalMs?: number };
}

/**
 * Tool settings for both sessions' workspaces. A type call's text is checked
 * by the next Enter's screenshot, so it does not attach one of its own: about
 * half the screenshots in the model's context while typing. Every other
 * action keeps its screenshot (and its 500 ms wait, which also gives the save
 * and open dialogs time to appear before the path is typed).
 */
export const LAUNCH_TOOLS: WorkspaceToolsConfig = {
  mastra_workspace_computer_type: { screenshotAfterAction: false },
};

const toCalls = (result: GenerateResult): SessionCall[] =>
  (result.steps as unknown as ToolStep[]).flatMap((s) => s.toolResults).map((c) => c.payload ?? {});

function logChecks(log: Log, checks: [string, boolean][]): boolean {
  for (const [name, passed] of checks) log(`  [${passed ? 'ok' : 'FAIL'}] ${name}`);
  return checks.every(([, passed]) => passed);
}

/**
 * After the checks: a cosmetic layout difference as a note (never a
 * failure); a text difference with where it is and whether the model's own
 * calls were right (input lost on the way) or wrong (model mistake).
 */
function logDifferences(log: Log, tag: string, c: { textDiff: string | null; layoutDiff: string | null }, keyedOk: boolean) {
  if (c.textDiff) {
    log(`${tag} text differs at ${c.textDiff}`);
    log(
      keyedOk
        ? `${tag} the agent's type and Enter calls spell the expected text: the input reached the editor differently`
        : `${tag} the agent's type and Enter calls do not spell the expected text: the model typed it differently`,
    );
  } else if (c.layoutDiff) {
    log(`${tag} note: cosmetic whitespace differs at ${c.layoutDiff} (allowed)`);
  }
}

function logRun(log: Log, tag: string, result: GenerateResult, calls: number) {
  const u = result.totalUsage;
  log(`${tag} ${result.steps.length} steps, ${calls} tool calls, ${u?.totalTokens ?? '?'} tokens`);
  log(`${tag} agent answer: ${JSON.stringify(result.text.trim().slice(0, 200))}`);
}

/**
 * Session 1 → pause → reconnect → Session 2 → independent checks. Returns
 * whether everything passed; stops at the first failed stage, so a failed
 * Session 1 never pauses the VM or calls the model again. Errors (provider,
 * model, timeout) propagate. Never destroys the VM: the caller's cleanup
 * does, through `onRestored`'s instance as well.
 */
export async function runLaunchDemo(o: LaunchDemoOptions): Promise<boolean> {
  const { sandbox, editor, budget, log } = o;
  const target = o.target ?? LAUNCH_DOC_PATH;
  const phase = (name: string) => o.onPhase?.(name);
  const savedId = sandbox.sandboxId;
  const read = async (sb: SuperserveSandbox) => {
    const r = await sb.executeCommand('cat', [target]);
    return r.exitCode === 0 ? r.stdout : '';
  };

  // ---- Session 1
  log(banner(`SESSION 1 · Mastra agent A drafts the launch brief · sandbox ${shortId(savedId)}`));
  phase('session 1 agent run');
  const agent1 = createDesktopAgent(o.workspace, o.models.session1);
  const r1 = await agent1.generate(session1Prompt(editor, budget, target), {
    maxSteps: o.maxSteps.session1,
    // Run the step's tool calls one at a time, in the order the model emitted
    // them. Mastra's default (up to 10 at once) let a batched type → Enter →
    // type reach the desktop out of order: misplaced or missing line breaks.
    toolCallConcurrency: 1,
    abortSignal: AbortSignal.timeout(o.timeoutMs),
    onChunk: createToolCallLogger((line) => log(line.replace(/^\[AGENT\]/, '[S1]'))),
  });
  const calls1 = toCalls(r1);
  logRun(log, '[S1]', r1, calls1.length);

  phase('session 1 independent check');
  const doc1 = await read(sandbox);
  const draft = checkDraft(doc1, budget);
  const review1 = reviewCalls(calls1, { target, editorBin: editor.bin });
  const keyed1 = keyedMatches(keyedText(calls1, S1_STARTS_AT), draftLines(budget));
  const s1ok = logChecks(log, [
    ['Session 1 took a screenshot', review1.screenshot],
    ['Session 1 clicked on the desktop', review1.clicked],
    ["Session 1's type and Enter calls spell the brief", keyed1],
    [`Session 1 did not launch ${editor.bin} from the shell`, !review1.shellLaunched],
    ['Session 1 did not write the file from the shell', !review1.shellModified],
    ['Session 1 did not send desktop input from the shell', !review1.shellInput],
    [`${target} holds the brief: headings, amounts and lines in order (read outside the agent)`, draft.correct],
    ['the NEXT work is left for Session 2', draft.leftForNext],
  ]);
  logDifferences(log, '[S1]', draft, keyed1);
  if (!s1ok) {
    log(`  file contents: ${JSON.stringify(doc1.trim())}`);
    log('[S1] FAIL: see the failed checks above (VM not paused, no Session 2)');
    return false;
  }
  o.saveShot?.('launch-1-session-1', (await sandbox.computer.screenshot()).data);

  // ---- Pause and reconnect (scripted, not agent actions)
  log(banner(`PAUSE → RECONNECT · scripted Superserve lifecycle · sandbox ${shortId(savedId)}`));
  let restored: { sandbox: SuperserveSandbox; workspace: Workspace } | undefined;
  phase('pause and reconnect');
  const persisted = await showcasePersistence({
    sandbox,
    workspace: o.workspace,
    target,
    expected: NEXT_LINE,
    expectedLabel: "Session 1's brief",
    sandboxOptions: o.sandboxOptions,
    tools: o.tools,
    onRestored: (r) => {
      restored = r;
      o.onRestored(r);
    },
    onScreenshot: (png) => o.saveShot?.('launch-2-after-reconnect', png),
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
  log(`[VM] One VM for this sandbox: ${shortId(savedId)} (no replacement created)`);

  if (o.beforeSession2) {
    phase('before session 2');
    await o.beforeSession2();
  }

  // ---- Session 2
  log(banner(`SESSION 2 · fresh Mastra agent B, no memory · sandbox ${shortId(restored.sandbox.sandboxId)}`));
  log('[S2] New Agent on the reconnected SuperserveSandbox. Its prompt names only the file and the section layout:');
  log('[S2] no budget amounts, no Session 1 messages, reasoning or memory.');
  phase('session 2 agent run');
  const agent2 = createDesktopAgent(restored.workspace, o.models.session2);
  const r2 = await agent2.generate(session2Prompt(editor, target), {
    maxSteps: o.maxSteps.session2,
    // Run the step's tool calls one at a time, in the order the model emitted
    // them. Mastra's default (up to 10 at once) let a batched type → Enter →
    // type reach the desktop out of order: misplaced or missing line breaks.
    toolCallConcurrency: 1,
    abortSignal: AbortSignal.timeout(o.timeoutMs),
    onChunk: createToolCallLogger((line) => log(line.replace(/^\[AGENT\]/, '[S2]'))),
  });
  const calls2 = toCalls(r2);
  logRun(log, '[S2]', r2, calls2.length);

  phase('session 2 independent check');
  const doc2 = await read(restored.sandbox);
  const fin = checkFinal(doc2, budget);
  const expected = fin.expectedTotal;
  const review2 = reviewCalls(calls2, { target, editorBin: editor.bin });
  const keyed2 = keyedMatches(keyedText(calls2, S2_STARTS_AT), sectionLines(expected));
  const finalIds = await listVmIds(sandbox.id);
  o.saveShot?.('launch-3-session-2', (await restored.sandbox.computer.screenshot()).data);

  const s2ok = logChecks(log, [
    [
      `same sandbox for Session 1, reconnect and Session 2 (${shortId(savedId)})`,
      restored.sandbox.sandboxId === savedId && finalIds.length === 1 && finalIds[0] === savedId,
    ],
    ['Session 2 took a screenshot', review2.screenshot],
    ['Session 2 clicked on the desktop', review2.clicked],
    ['Session 2 used the key tool', review2.pressedKey],
    ["Session 2's type and Enter calls spell the section with the correct total", keyed2],
    [`Session 2 did not launch ${editor.bin} from the shell`, !review2.shellLaunched],
    ['Session 2 did not modify the file from the shell', !review2.shellModified],
    ['Session 2 did not send desktop input from the shell', !review2.shellInput],
    ["Session 1's brief is intact", fin.draftKept],
    ['the COMPLETED section comes after the brief', fin.appended],
    [`total ${fin.total ?? '(missing)'} = ${budget.design} + ${budget.hosting} + ${budget.promotion} = ${expected}`, fin.totalCorrect],
    ['one COMPLETED section (heading, total, status once each)', fin.completedOnce],
    [`${target} holds the brief, then the section: headings, amounts and lines in order`, fin.correct],
    ['Session 2 reported the total', r2.text.replace(/,/g, '').includes(String(expected))],
  ]);
  logDifferences(log, '[S2]', fin, keyed2);
  if (!s2ok) log(`  file contents: ${JSON.stringify(doc2.trim())}`);

  log(banner('RESULT'));
  log(`  sandbox ${shortId(savedId)}: Session 1 → paused → reconnected → Session 2 (one VM throughout)`);
  log(`  Session 1: ${calls1.length} tool calls; brief saved with a NEXT handoff`);
  log(
    s2ok
      ? `  Session 2: ${calls2.length} tool calls; read the amounts, total ${expected}, section appended`
      : `  Session 2: ${calls2.length} tool calls; FAILED, see the checks above`,
  );
  return s2ok;
}
