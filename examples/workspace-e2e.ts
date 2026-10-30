/**
 * Phase 3 live integration: SuperserveSandbox inside a real Mastra Workspace,
 * driven only through Mastra's workspace tools (and a Mastra Agent), against
 * ONE real Superserve desktop VM that is always cleaned up.
 *
 * Every desktop action goes through `createWorkspaceTools(workspace)[name].execute()`
 * — the same wrapped, schema-validated tools an agent receives — and is
 * verified independently inside the VM: an X11 event recorder window logs the
 * exact button/motion events that arrived, xdotool reports the real cursor and
 * focused window, and typed shell commands must produce an exact file.
 *
 * Needs SUPERSERVE_API_KEY. Prints no secrets and no viewer URLs.
 *
 *   pnpm e2e
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkspaceTools, type Workspace } from '@mastra/core/workspace';
import { Sandbox } from '@superserve/sdk';
import { SANDBOX_ID_METADATA_KEY, SuperserveSandbox } from '../src/index.js';
import { pngSize } from '../src/utils.js';
import { createDesktopAgent, createDesktopWorkspace } from './desktop-agent.js';
import { scriptedModel } from './scripted-model.js';

const ART = 'artifacts';
const ID_FILE = '.sandbox-id';
const PURPOSE = { purpose: 'mastra-superserve-phase3-e2e' };
const DIR = '/tmp/mastra-e2e';
const DISPLAY = 'export DISPLAY=:1;';

type Status = 'PASS' | 'FAIL' | 'NOT VERIFIED';
const results: { id: string; test: string; status: Status; detail: string }[] = [];
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log('  ·', ...a);

function record(id: string, test: string, ok: boolean | 'skip', detail: string) {
  const status: Status = ok === 'skip' ? 'NOT VERIFIED' : ok ? 'PASS' : 'FAIL';
  results.push({ id, test, status, detail });
  console.log(`[${status}] ${id} ${test} — ${detail}`);
}

/** Run a check; an exception is a FAIL for that check, not the whole run. */
async function check(id: string, test: string, fn: () => Promise<[boolean | 'skip', string]>) {
  try {
    const [ok, detail] = await fn();
    record(id, test, ok, detail);
  } catch (e) {
    record(id, test, false, `threw: ${describe(e)}`);
  }
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const code = (e as { code?: string }).code;
  return `${e.name}${code ? `[${code}]` : ''}: ${e.message}`;
}

// ---------------------------------------------------------------------------
// Tool invocation through Mastra's real execution path
// ---------------------------------------------------------------------------

type Tools = Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>;
interface Media {
  __workspaceMedia: true;
  text: string;
  mediaType: string;
  data: string;
}
const isMedia = (r: unknown): r is Media => typeof r === 'object' && r !== null && '__workspaceMedia' in r;

async function callTool(tools: Tools, name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const out = await tool.execute(input, {});
  // Mastra returns schema-validation failures as a value instead of throwing.
  if (typeof out === 'object' && out !== null && (out as { error?: unknown }).error === true) {
    throw new Error(`tool ${name} returned an error: ${(out as { message?: string }).message}`);
  }
  return out;
}

function textOf(r: unknown): string {
  return typeof r === 'string' ? r : isMedia(r) ? r.text : JSON.stringify(r);
}

/** Run a shell command via the execute_command tool; returns its model-facing text. */
async function sh(tools: Tools, command: string, timeout = 30): Promise<string> {
  return textOf(await callTool(tools, 'mastra_workspace_execute_command', { command, timeout }));
}

// ---------------------------------------------------------------------------
// In-VM X11 event recorder (python3 + libX11 via ctypes; both present in
// superserve/desktop per Phase 1 test B2). Logs ButtonPress/Release/Motion
// with root coordinates as JSON lines. Receives input only; never acts.
// ---------------------------------------------------------------------------

const RECORDER_PY = String.raw`
import ctypes, ctypes.util, json, sys
from ctypes import c_int, c_uint, c_long, c_ulong, c_void_p, c_char_p
X = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11') or 'libX11.so.6')
X.XOpenDisplay.restype = c_void_p; X.XOpenDisplay.argtypes = [c_char_p]
X.XDefaultRootWindow.restype = c_ulong; X.XDefaultRootWindow.argtypes = [c_void_p]
X.XCreateSimpleWindow.restype = c_ulong
X.XCreateSimpleWindow.argtypes = [c_void_p, c_ulong, c_int, c_int, c_uint, c_uint, c_uint, c_ulong, c_ulong]
X.XStoreName.argtypes = [c_void_p, c_ulong, c_char_p]
X.XSelectInput.argtypes = [c_void_p, c_ulong, c_long]
X.XMapWindow.argtypes = [c_void_p, c_ulong]
X.XFlush.argtypes = [c_void_p]
X.XNextEvent.argtypes = [c_void_p, c_void_p]
class XButtonEvent(ctypes.Structure):
    _fields_ = [('type', c_int), ('serial', c_ulong), ('send_event', c_int), ('display', c_void_p),
                ('window', c_ulong), ('root', c_ulong), ('subwindow', c_ulong), ('time', c_ulong),
                ('x', c_int), ('y', c_int), ('x_root', c_int), ('y_root', c_int),
                ('state', c_uint), ('button', c_uint), ('same_screen', c_int)]
class XEvent(ctypes.Union):
    _fields_ = [('type', c_int), ('xbutton', XButtonEvent), ('pad', c_long * 24)]
d = X.XOpenDisplay(None)
if not d: sys.exit('cannot open display')
w = X.XCreateSimpleWindow(d, X.XDefaultRootWindow(d), 660, 80, 560, 520, 0, 0, 0xFFFFFF)
X.XStoreName(d, w, b'mastra-e2e-recorder')
X.XSelectInput(d, w, (1 << 2) | (1 << 3) | (1 << 6))  # ButtonPress | ButtonRelease | PointerMotion
X.XMapWindow(d, w); X.XFlush(d)
out = open(sys.argv[1], 'a', buffering=1)
names = {4: 'press', 5: 'release', 6: 'motion'}
ev = XEvent()
while True:
    X.XNextEvent(d, ctypes.byref(ev))
    if ev.type in names:
        b = ev.xbutton
        rec = {'t': names[ev.type], 'x': b.x_root, 'y': b.y_root, 'state': b.state, 'time': b.time}
        if ev.type != 6: rec['button'] = b.button
        out.write(json.dumps(rec) + '\n')
`;

interface XEventRec {
  t: 'press' | 'release' | 'motion';
  x: number;
  y: number;
  state: number;
  time: number;
  button?: number;
}

/** Reads recorder events appended since the previous read. */
function eventReader(getTools: () => Tools) {
  let seen = 0;
  return async (): Promise<XEventRec[]> => {
    const raw = await sh(getTools(), `cat ${DIR}/events.jsonl`);
    const lines = raw.split('\n').filter((l) => l.startsWith('{'));
    const fresh = lines.slice(seen);
    seen = lines.length;
    return fresh.map((l) => JSON.parse(l) as XEventRec);
  };
}

const buttons = (evs: XEventRec[], t: 'press' | 'release') => evs.filter((e) => e.t === t);
const fmt = (evs: XEventRec[]) => evs.map((e) => `${e.t}${e.button ?? ''}@(${e.x},${e.y})`).join(' ');

function parseShell(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) r[m[1]!] = m[2]!;
  }
  return r;
}

function parseScreenInfo(text: string) {
  const s = /Screen size: (\d+)x(\d+)/.exec(text);
  const c = /Cursor position: \((\d+), (\d+)\)/.exec(text);
  if (!s || !c) throw new Error(`unexpected screen info: ${text}`);
  return { width: Number(s[1]), height: Number(s[2]), x: Number(c[1]), y: Number(c[2]) };
}

async function waitForWindow(tools: Tools, query: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const out = (await sh(tools, `${DISPLAY} xdotool search --onlyvisible ${query} 2>/dev/null | tail -1`)).trim();
    if (/^\d+$/.test(out)) return out;
    await sleep(500);
  }
  const diag = await sh(
    tools,
    `${DISPLAY} id -un; ls -la ${DIR}; echo '--- recorder.log'; cat ${DIR}/recorder.log; echo '--- term.log'; cat ${DIR}/term.log; ` +
      `echo '--- procs'; ps -eo pid,user,args | grep -E 'recorder|xfce4-terminal' | grep -v grep; echo '--- windows'; xdotool search --onlyvisible --name . 2>&1 | head -20`,
  );
  throw new Error(`window never appeared: ${query}\n${diag}`);
}

async function placeWindow(tools: Tools, wid: string, x: number, y: number, w: number, h: number) {
  await sh(tools, `${DISPLAY} xdotool windowsize ${wid} ${w} ${h} windowmove ${wid} ${x} ${y}`);
  await sleep(500);
  const g = parseShell(await sh(tools, `${DISPLAY} xdotool getwindowgeometry --shell ${wid}`));
  return { x: Number(g.X), y: Number(g.Y), w: Number(g.WIDTH), h: Number(g.HEIGHT) };
}

function saveShot(name: string, r: unknown) {
  if (isMedia(r)) writeFileSync(`${ART}/${name}.png`, Buffer.from(r.data, 'base64'));
}

// ---------------------------------------------------------------------------
// Cleanup bookkeeping: the one VM this run creates
// ---------------------------------------------------------------------------

let ownedVmId: string | undefined;
/** Logical id of this run's sandbox; its VM is tagged with it, so it can be found even if create's response was lost. */
let runLogicalId: string | undefined;
let cleanupConfirmed = false;

async function vmStatus(id: string): Promise<string> {
  const rows = await Sandbox.list({ metadata: PURPOSE });
  return rows.find((r) => r.id === id)?.status ?? 'absent';
}

async function finalCleanup() {
  if (cleanupConfirmed || !runLogicalId) return;
  try {
    if (!ownedVmId) {
      const tagged = await Sandbox.list({ metadata: { ...PURPOSE, [SANDBOX_ID_METADATA_KEY]: runLogicalId } });
      ownedVmId = tagged.find((r) => r.status !== 'deleted')?.id;
      if (!ownedVmId) {
        cleanupConfirmed = true;
        console.log('\nCLEANUP: no VM was created by this run');
        return;
      }
    }
    let status = await vmStatus(ownedVmId);
    if (status !== 'deleted' && status !== 'absent') {
      console.log(`\nSAFETY NET: VM still ${status}; killing test-owned VM`);
      await Sandbox.killById(ownedVmId);
      status = await vmStatus(ownedVmId);
    }
    cleanupConfirmed = status === 'deleted' || status === 'absent';
    console.log(`\nCLEANUP: test-owned VM status after cleanup: ${status}`);
    if (cleanupConfirmed) rmSync(ID_FILE, { force: true });
  } catch (e) {
    console.error(`\nCLEANUP CHECK FAILED: ${describe(e)} — VM id is in ${ID_FILE}; kill it manually.`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.SUPERSERVE_API_KEY) throw new Error('SUPERSERVE_API_KEY is not set');
  mkdirSync(ART, { recursive: true });

  // ---- 1. Create through a real Workspace ----------------------------------
  const { sandbox, workspace } = createDesktopWorkspace({
    namePrefix: 'mastra-phase3',
    metadata: PURPOSE,
    timeoutSeconds: 900,
    autoDeleteSeconds: 600,
  });
  runLogicalId = sandbox.id;
  let tools: Tools = await createWorkspaceTools(workspace);
  const computerTools = Object.keys(tools).filter((n) => n.startsWith('mastra_workspace_computer_'));
  record(
    'T1',
    'workspace registers computer tools (no I/O)',
    computerTools.length === 11 && 'mastra_workspace_execute_command' in tools && sandbox.status === 'pending',
    `${computerTools.length} computer tools + execute_command; sandbox status=${sandbox.status}`,
  );

  log('workspace.init() → creating VM …');
  await workspace.init();
  ownedVmId = sandbox.sandboxId;
  if (ownedVmId) writeFileSync(ID_FILE, ownedVmId + '\n');
  record(
    'L1',
    'sandbox creation via Workspace.init()',
    sandbox.status === 'running' && !!ownedVmId && sandbox.ownership === 'created',
    `status=${sandbox.status} ownership=${sandbox.ownership} (${elapsed()})`,
  );
  if (!ownedVmId) throw new Error('no VM id after init');

  // ---- 2. Screenshot + screen info ----------------------------------------
  let screen = { width: 0, height: 0 };
  await check('C1', 'screenshot tool returns a real PNG', async () => {
    const r = await callTool(tools, 'mastra_workspace_computer_screenshot', {});
    if (!isMedia(r)) return [false, `not media: ${textOf(r)}`];
    saveShot('phase3-initial', r);
    const size = pngSize(Buffer.from(r.data, 'base64'));
    screen = size ?? screen;
    return [r.mediaType === 'image/png' && !!size, `${r.mediaType} ${size?.width}x${size?.height}, ${r.data.length} b64 chars`];
  });
  await check('C2', 'get_screen_info tool matches the screenshot', async () => {
    const info = parseScreenInfo(textOf(await callTool(tools, 'mastra_workspace_computer_get_screen_info', {})));
    return [info.width === screen.width && info.height === screen.height, `size ${info.width}x${info.height}, cursor (${info.x},${info.y})`];
  });

  // ---- 3. Command execution -----------------------------------------------
  await check('X1', 'execute_command tool runs in the VM', async () => {
    const out = await sh(tools, 'echo phase3-ok && uname -sm');
    return [out.includes('phase3-ok') && out.includes('Linux'), JSON.stringify(out.trim())];
  });
  await check('X2', 'execute_command tool reports non-zero exit', async () => {
    const out = await sh(tools, "echo to-stderr >&2; exit 7");
    return [out.includes('Exit code: 7') && out.includes('to-stderr'), JSON.stringify(out.trim())];
  });

  // ---- 4. Set up the recorder window and a terminal -------------------------
  await sh(tools, `mkdir -p ${DIR}`);
  await sandbox.writeFiles([{ path: `${DIR}/recorder.py`, content: RECORDER_PY }]);
  log(`recorder.py in VM: ${(await sh(tools, `wc -c < ${DIR}/recorder.py`)).trim()} bytes (local ${RECORDER_PY.length})`);
  const recPid = (
    await sh(tools, `${DISPLAY} : > ${DIR}/events.jsonl; setsid python3 ${DIR}/recorder.py ${DIR}/events.jsonl >${DIR}/recorder.log 2>&1 & echo $!`)
  ).trim();
  await sh(tools, `${DISPLAY} setsid xfce4-terminal --disable-server --title=mastra-e2e-term >${DIR}/term.log 2>&1 &`);
  const recWid = await waitForWindow(tools, `--name '^mastra-e2e-recorder$'`);
  const termWid = await waitForWindow(tools, `--name '^mastra-e2e-term$'`);
  await sleep(1500); // let the terminal's shell print its prompt
  const rec = await placeWindow(tools, recWid, 660, 80, 560, 520);
  const term = await placeWindow(tools, termWid, 20, 80, 600, 380);
  log(`recorder pid=${recPid} window ${rec.w}x${rec.h}+${rec.x}+${rec.y}; terminal ${term.w}x${term.h}+${term.x}+${term.y}`);
  const inRec = (dx: number, dy: number) => ({ x: rec.x + dx, y: rec.y + dy });
  const readEvents = eventReader(() => tools);
  await readEvents(); // discard events from window placement

  // ---- 5. Mouse ----------------------------------------------------------
  await check('M1', 'move_mouse → real cursor position (xdotool) + X motion event', async () => {
    const p = inRec(150, 120);
    await callTool(tools, 'mastra_workspace_computer_move_mouse', p);
    const info = parseScreenInfo(textOf(await callTool(tools, 'mastra_workspace_computer_get_screen_info', {})));
    const motion = (await readEvents()).filter((e) => e.t === 'motion');
    const last = motion.at(-1);
    const ok = info.x === p.x && info.y === p.y && last?.x === p.x && last?.y === p.y;
    return [ok, `target (${p.x},${p.y}); xdotool cursor (${info.x},${info.y}); last X motion (${last?.x},${last?.y})`];
  });

  await check('M2', 'click → exactly one button-1 press/release at the target', async () => {
    const p = inRec(200, 160);
    await callTool(tools, 'mastra_workspace_computer_click', p);
    const evs = await readEvents();
    const press = buttons(evs, 'press');
    const release = buttons(evs, 'release');
    const ok =
      press.length === 1 && release.length === 1 && press[0]!.button === 1 && release[0]!.button === 1 &&
      press[0]!.x === p.x && press[0]!.y === p.y;
    return [ok, `target (${p.x},${p.y}): ${fmt([...press, ...release])}`];
  });

  await check('M3', 'right_click → button-3 press/release at the target', async () => {
    const p = inRec(260, 200);
    await callTool(tools, 'mastra_workspace_computer_right_click', p);
    const evs = await readEvents();
    const press = buttons(evs, 'press');
    const ok = press.length === 1 && press[0]!.button === 3 && press[0]!.x === p.x && press[0]!.y === p.y &&
      buttons(evs, 'release').some((e) => e.button === 3);
    return [ok, `target (${p.x},${p.y}): ${fmt(buttons(evs, 'press').concat(buttons(evs, 'release')))}`];
  });

  await check('M4', 'double_click → two button-1 presses at the target, within 500 ms', async () => {
    const p = inRec(300, 240);
    await callTool(tools, 'mastra_workspace_computer_double_click', p);
    const press = buttons(await readEvents(), 'press');
    const dt = press.length === 2 ? press[1]!.time - press[0]!.time : NaN;
    const ok = press.length === 2 && press.every((e) => e.button === 1 && e.x === p.x && e.y === p.y) && dt >= 0 && dt < 500;
    return [ok, `target (${p.x},${p.y}): ${fmt(press)}; Δt=${dt} ms`];
  });

  await check('M5', 'drag → press at start, button-1 motion, release at end', async () => {
    const a = inRec(60, 300);
    const b = inRec(420, 380);
    await callTool(tools, 'mastra_workspace_computer_drag', { startX: a.x, startY: a.y, endX: b.x, endY: b.y });
    const evs = await readEvents();
    const press = buttons(evs, 'press');
    const release = buttons(evs, 'release');
    const pressIdx = evs.findIndex((e) => e.t === 'press');
    const releaseIdx = evs.findIndex((e) => e.t === 'release');
    const heldMotion = evs.slice(pressIdx, releaseIdx).filter((e) => e.t === 'motion' && (e.state & 0x100) !== 0);
    const ok =
      press.length === 1 && release.length === 1 && press[0]!.button === 1 && release[0]!.button === 1 &&
      press[0]!.x === a.x && press[0]!.y === a.y && release[0]!.x === b.x && release[0]!.y === b.y &&
      pressIdx < releaseIdx && heldMotion.length > 0;
    return [ok, `(${a.x},${a.y})→(${b.x},${b.y}): ${fmt([...press, ...release])}; ${heldMotion.length} motion event(s) with button 1 held`];
  });

  await check('M6', 'scroll down 3 / up 2 → wheel buttons 5×3 then 4×2 under the pointer', async () => {
    await callTool(tools, 'mastra_workspace_computer_move_mouse', inRec(280, 260));
    await readEvents();
    await callTool(tools, 'mastra_workspace_computer_scroll', { direction: 'down', amount: 3 });
    const down = buttons(await readEvents(), 'press').map((e) => e.button);
    await callTool(tools, 'mastra_workspace_computer_scroll', { direction: 'up', amount: 2 });
    const up = buttons(await readEvents(), 'press').map((e) => e.button);
    const ok = down.length === 3 && down.every((b) => b === 5) && up.length === 2 && up.every((b) => b === 4);
    return [ok, `down → buttons [${down}], up → buttons [${up}]`];
  });

  // ---- 6. Keyboard (real app: the terminal) --------------------------------
  const token = `p3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await check('K1', 'click focuses the terminal; type + press (incl. ctrl+u chord) runs an exact command', async () => {
    const c = { x: term.x + Math.floor(term.w / 2), y: term.y + Math.floor(term.h / 2) };
    await callTool(tools, 'mastra_workspace_computer_click', c);
    const focus = (await sh(tools, `${DISPLAY} xdotool getwindowfocus`)).trim();
    if (focus !== termWid) return [false, `focus ${focus} ≠ terminal ${termWid}; no keys sent`];
    // Junk first, then ctrl+u must erase it — otherwise the file content is wrong.
    await callTool(tools, 'mastra_workspace_computer_type', { text: 'echo JUNK-SHOULD-BE-ERASED' });
    await callTool(tools, 'mastra_workspace_computer_press_key', { key: ['ctrl', 'u'] });
    await callTool(tools, 'mastra_workspace_computer_type', { text: `echo ${token} > ${DIR}/typed.txt` });
    const pressed = await callTool(tools, 'mastra_workspace_computer_press_key', { key: 'Enter' });
    saveShot('phase3-after-typing', pressed);
    let content = '';
    for (let i = 0; i < 20 && !content; i++) {
      content = await sh(tools, `cat ${DIR}/typed.txt 2>/dev/null || true`);
      if (content.includes('(no output)')) content = '';
      if (!content) await sleep(250);
    }
    return [content.trim() === token, `focus=terminal ✓; ${DIR}/typed.txt = ${JSON.stringify(content.trim())} (expected token)`];
  });

  // ---- 7. Pause (Workspace.stop) and reconnect from a fresh instance --------
  await sh(tools, `echo persisted-${token} > ${DIR}/persist.txt`);
  await check('P1', 'Workspace.stop() pauses the VM (control plane says paused)', async () => {
    await workspace.stop();
    const status = await vmStatus(ownedVmId!);
    return [sandbox.status === 'stopped' && status === 'paused' && sandbox.sandboxId === ownedVmId, `sandbox.status=${sandbox.status}, VM=${status}, id kept=${sandbox.sandboxId === ownedVmId}`];
  });

  await check('O1', 'reattach under a different logical id is refused, VM not resumed', async () => {
    const intruder = new SuperserveSandbox({ id: 'phase3-someone-else', sandboxId: ownedVmId });
    let code = 'none';
    try {
      await intruder.start();
    } catch (e) {
      code = (e as { code?: string }).code ?? describe(e);
    }
    const status = await vmStatus(ownedVmId!);
    return [code === 'OWNERSHIP_MISMATCH' && status === 'paused', `error=${code}, VM still ${status}`];
  });

  // Fresh instance, as after a process restart: only the persisted VM id survives.
  const second = createDesktopWorkspace({ sandboxId: ownedVmId });
  const sandbox2 = second.sandbox;
  const workspace2: Workspace = second.workspace;
  tools = await createWorkspaceTools(workspace2);

  await check('P2', 'fresh instance reconnects to the same VM via sandboxId', async () => {
    const out = await sh(tools, `cat ${DIR}/persist.txt`);
    return [
      out.trim() === `persisted-${token}` && sandbox2.sandboxId === ownedVmId && sandbox2.ownership === 'adopted',
      `file=${JSON.stringify(out.trim())}, same VM=${sandbox2.sandboxId === ownedVmId}, ownership=${sandbox2.ownership}`,
    ];
  });
  await check('P3', 'processes and desktop state survived pause/resume', async () => {
    const alive = (await sh(tools, `kill -0 ${recPid} && echo ALIVE || echo DEAD`)).trim();
    const wins = (await sh(tools, `${DISPLAY} xdotool search --onlyvisible --name '^mastra-e2e-(recorder|term)$' | wc -l`)).trim();
    const shot = await callTool(tools, 'mastra_workspace_computer_screenshot', {});
    saveShot('phase3-after-resume', shot);
    return [alive === 'ALIVE' && wins === '2' && isMedia(shot), `recorder ${alive}, ${wins}/2 windows mapped, screenshot ok=${isMedia(shot)}`];
  });
  await check('P4', 'input still lands after resume (recorder sees the click)', async () => {
    const p = inRec(222, 333);
    await callTool(tools, 'mastra_workspace_computer_click', p);
    const press = buttons(await readEvents(), 'press');
    return [press.length === 1 && press[0]!.x === p.x && press[0]!.y === p.y, `target (${p.x},${p.y}): ${fmt(press)}`];
  });

  await check('O2', "a non-owning attach (killOnDestroy: 'never') detaches without killing", async () => {
    const observer = new SuperserveSandbox({ sandboxId: ownedVmId, killOnDestroy: 'never' });
    await observer.start();
    await observer.destroy();
    const status = await vmStatus(ownedVmId!);
    const still = (await sh(tools, `cat ${DIR}/persist.txt`)).trim();
    return [status === 'active' && still === `persisted-${token}`, `after observer.destroy(): VM ${status}, primary instance still works=${still === `persisted-${token}`}`];
  });

  // ---- 8. Agent loop (scripted model, no LLM) on the same VM ---------------
  await check('A1', 'Mastra Agent drives the desktop through the workspace tools', async () => {
    const c = { x: term.x + Math.floor(term.w / 2), y: term.y + Math.floor(term.h / 2) };
    const agentFile = `${DIR}/agent.txt`;
    const agent = createDesktopAgent(
      workspace2,
      scriptedModel([
        { toolCalls: [{ toolName: 'mastra_workspace_computer_screenshot', input: {} }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_click', input: c }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_type', input: { text: `echo agent-${token} > ${agentFile}` } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_press_key', input: { key: 'Enter' } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_execute_command', input: { command: `sleep 1; cat ${agentFile}` } }] },
        { text: 'Done.' },
      ]),
    );
    const result = await agent.generate('Write the token to the file using the terminal.', { maxSteps: 8 });
    const calls = result.toolResults.map((r) => (r as { payload?: { toolName?: string } }).payload?.toolName);
    const last = JSON.stringify((result.toolResults.at(-1) as { payload?: { result?: unknown } })?.payload?.result ?? '');
    const verified = (await sh(tools, `cat ${agentFile}`)).trim();
    const ok = result.text === 'Done.' && calls.length === 5 && verified === `agent-${token}` && last.includes(`agent-${token}`);
    return [ok, `${calls.length} tool calls [${calls.map((n) => n?.replace('mastra_workspace_', '')).join(', ')}]; file=${JSON.stringify(verified)}; answer=${JSON.stringify(result.text)}`];
  });

  // ---- 9. streamUrl (checked, never printed) -------------------------------
  await check('S1', 'computer.streamUrl() returns an https viewer URL (not printed)', async () => {
    const url = await sandbox2.computer.streamUrl?.();
    const ok = !!url && new URL(url).protocol === 'https:';
    return [ok, `https=${ok}, length=${url?.length ?? 0} (redacted)`];
  });

  // ---- 10. Cleanup through Mastra -----------------------------------------
  await check('D1', 'Workspace.destroy() kills the adopted VM', async () => {
    await workspace2.destroy();
    let status = await vmStatus(ownedVmId!);
    for (let i = 0; i < 10 && status !== 'deleted' && status !== 'absent'; i++) {
      await sleep(1000);
      status = await vmStatus(ownedVmId!);
    }
    return [sandbox2.status === 'destroyed' && sandbox2.sandboxId === undefined && (status === 'deleted' || status === 'absent'), `sandbox.status=${sandbox2.status}, VM=${status}`];
  });
  await check('D2', 'destroying the stale first workspace after the VM is gone is a clean no-op', async () => {
    await workspace.destroy();
    return [sandbox.status === 'destroyed', `sandbox.status=${sandbox.status}`];
  });
}

let fatal: unknown;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.error(`\n${sig} received — cleaning up`);
    await finalCleanup();
    process.exit(130);
  });
}
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nFATAL: ${e instanceof Error ? e.stack : e}`);
} finally {
  await finalCleanup();
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; cleanup confirmed=${cleanupConfirmed}; wall time ${elapsed()}`);
  writeFileSync(
    `${ART}/phase3-results.json`,
    JSON.stringify({ cleanupConfirmed, fatal: fatal ? describe(fatal) : null, results }, null, 2),
  );
  process.exitCode = fatal || failed.length || !cleanupConfirmed ? 1 : 0;
}
