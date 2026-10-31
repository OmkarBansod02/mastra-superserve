// Live smoke test of the raw @superserve/sdk desktop API (no Mastra): one
// superserve/desktop sandbox, always destroyed in finally.
// The SDK reads SUPERSERVE_API_KEY from the environment; this script never touches it.
import { Sandbox } from "@superserve/sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

type Status = "PASS" | "FAIL" | "BLOCKED";
const results: { id: string; test: string; status: Status; detail: string }[] = [];
const record = (id: string, test: string, status: Status, detail: string) => {
  results.push({ id, test, status, detail });
  console.log(`[${status}] ${id} ${test} — ${detail}`);
};
const log = (...a: unknown[]) => console.log("  ·", ...a);

const ART = "artifacts";
const ID_FILE = ".sandbox-id";
mkdirSync(ART, { recursive: true });
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Read width/height straight from the PNG IHDR chunk to cross-check SDK-reported values.
function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function parseShell(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) r[m[1]] = m[2];
  }
  return r;
}

let sandbox: Sandbox | undefined;
let sandboxId: string | undefined;
let cleanupOk = false;

async function main() {
  // ---- create exactly one VM -------------------------------------------------
  log("creating sandbox from superserve/desktop …");
  sandbox = await Sandbox.create({
    name: `mastra-phase1-smoke-${Date.now()}`,
    fromTemplate: "superserve/desktop",
    timeoutSeconds: 900, // auto-pause after 15 min active
    autoDeleteSeconds: 600, // delete after 10 min continuously paused
    metadata: { purpose: "mastra-superserve-phase1-smoke" },
  });
  sandboxId = sandbox.id;
  writeFileSync(ID_FILE, sandboxId + "\n");
  log(`sandbox ${sandboxId} status=${sandbox.status} (${elapsed()})`);
  const info = await sandbox.getInfo();
  log(`info: vcpu=${info.vcpuCount} mem=${info.memoryMib}MiB timeout=${info.timeoutSeconds} autoDelete=${info.autoDeleteSeconds}`);

  const sh = (cmd: string, env?: Record<string, string>) =>
    sandbox!.commands.run(cmd, { timeoutMs: 30_000, env });

  // ---- B0: environment discovery (read-only) --------------------------------
  const probe = await sh(
    [
      'echo "DISPLAY_ENV=${DISPLAY:-<unset>}"',
      'echo "USER=$(id -un) UID=$(id -u)"',
      "echo '--- X sockets'; ls -la /tmp/.X11-unix 2>&1",
      "echo '--- X/VNC processes'; ps -eo pid,user,args 2>/dev/null | grep -iE 'Xvfb|Xvnc|Xorg|x11vnc|vnc|xfce|openbox|fluxbox|xterm|novnc|websockify' | grep -v grep",
      "echo '--- tools'; for t in xdotool xdpyinfo xwininfo xinput xprop xev xterm xfce4-terminal lxterminal gnome-terminal python3 xsel xclip; do printf '%s=' $t; command -v $t || echo MISSING; done",
      "echo '--- python Xlib'; python3 -c 'import Xlib; print(\"python-xlib\", Xlib.__version__)' 2>&1 | tail -1",
      "echo '--- libX11'; ls /usr/lib/x86_64-linux-gnu/libX11.so* /usr/lib/*/libX11.so* 2>/dev/null | head -3",
      "echo '--- os'; head -2 /etc/os-release",
    ].join("; "),
  );
  console.log(probe.stdout.split("\n").map((l) => "    " + l).join("\n"));
  const has = (t: string) => new RegExp(`^${t}=/`, "m").test(probe.stdout);

  // Determine DISPLAY: process env first, then the X socket that exists.
  let display = probe.stdout.match(/^DISPLAY_ENV=(.*)$/m)?.[1] ?? "<unset>";
  const displaySource = display !== "<unset>" ? "process env" : "X socket";
  if (display === "<unset>") {
    const sock = probe.stdout.match(/\bX(\d+)\s*$/m)?.[1];
    display = sock !== undefined ? `:${sock}` : "<unset>";
  }
  log(`DISPLAY=${display} (from ${displaySource}); xdotool=${has("xdotool")}`);
  const xenv = display !== "<unset>" ? { DISPLAY: display } : undefined;

  // ---- A1: screenshot + dimensions ------------------------------------------
  let screenW = 0, screenH = 0;
  try {
    const shot = await sandbox.desktop.screenshot();
    const ihdr = pngSize(shot.data);
    writeFileSync(`${ART}/shot-initial.png`, shot.data);
    screenW = shot.width; screenH = shot.height;
    const ok = shot.format === "png" && ihdr !== null && ihdr.width === shot.width && ihdr.height === shot.height;
    record("A1", "PNG screenshot + dimensions", ok ? "PASS" : "FAIL",
      `format=${shot.format} sdk=${shot.width}x${shot.height} ihdr=${ihdr ? `${ihdr.width}x${ihdr.height}` : "not-PNG"} bytes=${shot.data.length}`);
  } catch (e) {
    record("A1", "PNG screenshot + dimensions", "FAIL", String(e));
  }
  if (xenv && has("xdpyinfo")) {
    const d = await sh("xdpyinfo | grep -E 'dimensions|depth of root'", xenv);
    log(`xdpyinfo: ${d.stdout.trim().replace(/\s+/g, " ")}`);
  }

  // ---- B: cursor position (critical) -----------------------------------------
  const readCursor = async (): Promise<{ x: number; y: number } | string> => {
    if (!xenv || !has("xdotool")) return "xdotool or DISPLAY unavailable";
    const r = await sh("xdotool getmouselocation --shell", xenv);
    if (r.exitCode !== 0) return `exit ${r.exitCode}: ${r.stderr.trim()}`;
    const p = parseShell(r.stdout);
    if (p.X === undefined || p.Y === undefined) return `unparseable: ${r.stdout.trim()}`;
    return { x: Number(p.X), y: Number(p.Y) };
  };

  const targets: [number, number][] = [
    [137, 211],
    [Math.max(1, Math.floor(screenW * 0.7)) || 600, Math.max(1, Math.floor(screenH * 0.6)) || 400],
    [0, 0],
  ];
  const before = await readCursor();
  log(`cursor before any move: ${JSON.stringify(before)}`);
  let cursorMatches = 0, cursorTried = 0;
  const cursorLog: string[] = [`before=${JSON.stringify(before)}`];
  let moveOk = true;
  for (const [x, y] of targets) {
    try {
      await sandbox.desktop.moveMouse(x, y);
    } catch (e) {
      moveOk = false;
      cursorLog.push(`moveMouse(${x},${y}) threw: ${e}`);
      break; // no blind retries
    }
    const got = await readCursor();
    cursorTried++;
    const match = typeof got === "object" && got.x === x && got.y === y;
    if (match) cursorMatches++;
    cursorLog.push(`move(${x},${y})→read ${JSON.stringify(got)} ${match ? "✓" : "✗"}`);
  }
  record("A2", "moveMouse to known coordinates", moveOk ? "PASS" : "FAIL", `${targets.length} moves issued`);
  if (typeof before === "string") {
    record("B1", "xdotool getmouselocation --shell", "BLOCKED", `${before}; ${cursorLog.join("; ")}`);
  } else {
    record("B1", "xdotool getmouselocation --shell", cursorMatches === cursorTried && cursorTried === targets.length ? "PASS" : "FAIL",
      `${cursorMatches}/${cursorTried} exact matches; ${cursorLog.join("; ")}`);
  }

  // B2: independent read-only cross-check via XQueryPointer (libX11 through ctypes, no installs).
  {
    const [x, y] = [321, 123];
    await sandbox.desktop.moveMouse(x, y);
    const py = [
      "import ctypes,ctypes.util,sys",
      "n=ctypes.util.find_library('X11')",
      "assert n, 'libX11 not found'",
      "X=ctypes.cdll.LoadLibrary(n)",
      "X.XOpenDisplay.restype=ctypes.c_void_p",
      "X.XDefaultRootWindow.restype=ctypes.c_ulong; X.XDefaultRootWindow.argtypes=[ctypes.c_void_p]",
      "d=X.XOpenDisplay(None)",
      "assert d, 'cannot open display'",
      "r=X.XDefaultRootWindow(d)",
      "rr=ctypes.c_ulong(); cw=ctypes.c_ulong(); rx=ctypes.c_int(); ry=ctypes.c_int(); wx=ctypes.c_int(); wy=ctypes.c_int(); m=ctypes.c_uint()",
      "X.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong]+[ctypes.c_void_p]*7",
      "ok=X.XQueryPointer(d,r,ctypes.byref(rr),ctypes.byref(cw),ctypes.byref(rx),ctypes.byref(ry),ctypes.byref(wx),ctypes.byref(wy),ctypes.byref(m))",
      "print(f'OK={ok} X={rx.value} Y={ry.value}')",
    ].join("\n");
    if (!xenv || !has("python3")) {
      record("B2", "XQueryPointer cross-check (python3+libX11)", "BLOCKED", "python3 or DISPLAY unavailable");
    } else {
      await sandbox.files.write("/tmp/qp.py", py);
      const r = await sh("python3 /tmp/qp.py", xenv);
      const p = parseShell(r.stdout.replace(/ /g, "\n"));
      const xd = await readCursor();
      const ok = r.exitCode === 0 && Number(p.X) === x && Number(p.Y) === y;
      record("B2", "XQueryPointer cross-check (python3+libX11)", r.exitCode !== 0 ? "BLOCKED" : ok ? "PASS" : "FAIL",
        `target=(${x},${y}) XQueryPointer=${r.stdout.trim() || r.stderr.trim().split("\n").pop()} xdotool=${JSON.stringify(xd)}`);
    }
  }

  // ---- A3: click + keyboard, verified via an xterm writing stdin to a file ---
  if (!xenv || !has("xterm")) {
    record("A3", "click + keyboard input verified", "BLOCKED", "no xterm (or DISPLAY) to verify input safely");
  } else {
    await sandbox.commands.spawn(
      "xterm -geometry 60x10+40+40 -title phase1-kbd -e sh -c 'cat > /tmp/kbd.txt'",
      { env: xenv },
    );
    // Wait (bounded) for the window to map.
    let mapped = false;
    for (let i = 0; i < 20 && !mapped; i++) {
      const w = await sh("xdotool search --name phase1-kbd 2>/dev/null | head -1", xenv);
      mapped = w.stdout.trim().length > 0;
      if (!mapped) await new Promise((r) => setTimeout(r, 500));
    }
    if (!mapped) {
      record("A3", "click + keyboard input verified", "FAIL", "xterm window never mapped");
    } else {
      const geo = await sh("xdotool search --name phase1-kbd getwindowgeometry --shell | head -6", xenv);
      const g = parseShell(geo.stdout);
      const cx = Number(g.X) + Math.floor(Number(g.WIDTH) / 2);
      const cy = Number(g.Y) + Math.floor(Number(g.HEIGHT) / 2);
      log(`xterm geometry ${geo.stdout.trim().replace(/\n/g, " ")} → click (${cx},${cy})`);
      await sandbox.desktop.click(cx, cy);
      const afterClick = await readCursor();
      const focus = await sh("xdotool getwindowfocus getwindowname", xenv);
      const token = `phase1-${Math.random().toString(36).slice(2, 8)}`;
      await sandbox.desktop.write(token);
      await sandbox.desktop.press("enter");
      await sandbox.desktop.press("ctrl+d"); // EOF → cat exits, xterm closes
      await new Promise((r) => setTimeout(r, 800));
      const shot = await sandbox.desktop.screenshot();
      writeFileSync(`${ART}/shot-after-input.png`, shot.data);
      const got = await sh("cat /tmp/kbd.txt 2>&1");
      const ok = got.stdout.trim() === token;
      record("A3", "click + keyboard input verified", ok ? "PASS" : "FAIL",
        `click(${cx},${cy}) cursor→${JSON.stringify(afterClick)} focus="${focus.stdout.trim()}" typed="${token}" file="${got.stdout.trim()}"`);
    }
  }

  // ---- C: commands and files -------------------------------------------------
  {
    const r = await sh("echo hello-from-sandbox && uname -sm");
    record("C1", "simple shell command", r.exitCode === 0 && r.stdout.startsWith("hello-from-sandbox") ? "PASS" : "FAIL",
      `exit=${r.exitCode} stdout=${JSON.stringify(r.stdout.trim())}`);
  }
  const persistPath = "/home/phase1-persist.txt";
  const persistBody = `persist-${Date.now()}\nline2 ✓\n`;
  let persistTarget = persistPath;
  {
    try {
      await sandbox.files.write(persistPath, persistBody);
    } catch {
      persistTarget = "/tmp/phase1-persist.txt";
      await sandbox.files.write(persistTarget, persistBody);
    }
    const back = await sandbox.files.readText(persistTarget);
    const viaShell = await sh(`cat ${persistTarget}`);
    record("C2", "file write + read", back === persistBody && viaShell.stdout === persistBody ? "PASS" : "FAIL",
      `path=${persistTarget} roundtrip=${back === persistBody} shellView=${viaShell.stdout === persistBody}`);
  }
  {
    let detail: string, ok: boolean;
    try {
      const r = await sh("echo to-stderr >&2; exit 7");
      ok = r.exitCode === 7 && r.stderr.includes("to-stderr");
      detail = `resolved (no throw) exitCode=${r.exitCode} stderr=${JSON.stringify(r.stderr.trim())}`;
      const r2 = await sh("ls /definitely/not/here");
      detail += `; ls missing → exitCode=${r2.exitCode}`;
      ok = ok && r2.exitCode !== 0;
    } catch (e) {
      ok = false;
      detail = `threw instead of returning exitCode: ${e}`;
    }
    record("C3", "non-zero exit handled", ok ? "PASS" : "FAIL", detail);
  }

  // ---- D: pause → connect → verify ------------------------------------------
  {
    const tp = Date.now();
    await sandbox.pause({ wait: true, timeoutMs: 120_000 });
    const st = (await sandbox.getInfo()).status; // getInfo does not activate
    log(`paused in ${Date.now() - tp}ms, status=${st}`);
    record("D1", "pause VM", st === "paused" ? "PASS" : "FAIL", `status=${st} after ${Date.now() - tp}ms`);

    const tc = Date.now();
    const re = await Sandbox.connect(sandboxId!);
    sandbox = re;
    const st2 = (await re.getInfo()).status;
    record("D2", "Sandbox.connect(id) after pause", re.id === sandboxId && st2 === "active" ? "PASS" : "FAIL",
      `id match=${re.id === sandboxId} status=${st2} in ${Date.now() - tc}ms`);

    const back = await re.files.readText(persistTarget);
    record("D3", "file persisted across pause", back === persistBody ? "PASS" : "FAIL", `path=${persistTarget}`);

    try {
      const shot = await re.desktop.screenshot();
      writeFileSync(`${ART}/shot-after-resume.png`, shot.data);
      const [x, y] = [222, 333];
      await re.desktop.moveMouse(x, y);
      let cur: unknown = "n/a";
      if (xenv && has("xdotool")) {
        const r = await re.commands.run("xdotool getmouselocation --shell", { env: xenv, timeoutMs: 30_000 });
        const p = parseShell(r.stdout);
        cur = { x: Number(p.X), y: Number(p.Y) };
      }
      const curOk = typeof cur === "object" && (cur as any).x === x && (cur as any).y === y;
      record("D4", "desktop usable after resume", curOk ? "PASS" : "FAIL",
        `screenshot ${shot.width}x${shot.height}; move(${x},${y})→xdotool ${JSON.stringify(cur)}`);
    } catch (e) {
      record("D4", "desktop usable after resume", "FAIL", String(e));
    }
  }
}

async function cleanup() {
  if (!sandboxId) return;
  try {
    await Sandbox.killById(sandboxId);
    // Verify: deleted sandboxes either 404 or report status=deleted.
    let state = "unknown";
    try {
      const list = await Sandbox.list({ metadata: { purpose: "mastra-superserve-phase1-smoke" } });
      const me = list.find((s) => s.id === sandboxId);
      state = me ? me.status : "absent from list";
    } catch (e) {
      state = `list failed: ${e}`;
    }
    cleanupOk = state === "deleted" || state === "absent from list";
    console.log(`\nCLEANUP: killById(${sandboxId}) done; post-check: ${state}`);
    if (cleanupOk) rmSync(ID_FILE, { force: true });
  } catch (e) {
    console.error(`\nCLEANUP FAILED for sandbox ${sandboxId}: ${e}`);
    console.error(`Manual cleanup: node -e "import('@superserve/sdk').then(m=>m.Sandbox.killById('${sandboxId}'))"`);
  }
}

let fatal: unknown;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.error(`\n${sig} received — destroying sandbox`);
    await cleanup();
    process.exit(130);
  });
}
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`\nFATAL: ${e instanceof Error ? e.stack : e}`);
} finally {
  await cleanup();
  console.log(`\nTotal wall time: ${elapsed()}`);
  writeFileSync(`${ART}/results.json`, JSON.stringify({ sandboxId, cleanupOk, fatal: fatal ? String(fatal) : null, results }, null, 2));
  process.exitCode = fatal || !cleanupOk ? 1 : 0;
}
