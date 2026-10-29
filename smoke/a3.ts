// Phase 1 / A3 only: click + keyboard input verified through xfce4-terminal.
// One superserve/desktop sandbox, always destroyed in finally.
// The SDK reads SUPERSERVE_API_KEY from the environment; this script never touches it.
import { Sandbox } from "@superserve/sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const ART = "artifacts";
const ID_FILE = ".sandbox-id";
const TARGET = "/tmp/phase1-input-test.txt";
const META = { purpose: "mastra-superserve-phase1-a3" };
mkdirSync(ART, { recursive: true });
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log("  ·", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
let status = "FAIL" as "PASS" | "FAIL" | "BLOCKED";
const evidence: string[] = [];
const note = (s: string) => { evidence.push(s); log(s); };

async function main() {
  log("creating sandbox from superserve/desktop …");
  sandbox = await Sandbox.create({
    name: `mastra-phase1-a3-${Date.now()}`,
    fromTemplate: "superserve/desktop",
    timeoutSeconds: 900, // auto-pause after 15 min active
    autoDeleteSeconds: 600, // delete after 10 min continuously paused
    metadata: META,
  });
  sandboxId = sandbox.id;
  writeFileSync(ID_FILE, sandboxId + "\n");
  note(`sandbox ${sandboxId} status=${sandbox.status} (${elapsed()})`);

  const env = { DISPLAY: ":1" };
  const sh = (cmd: string) => sandbox!.commands.run(cmd, { timeoutMs: 30_000, env });

  // Precondition: target file must not exist yet.
  const pre = await sh(`test -e ${TARGET} && echo EXISTS || echo ABSENT`);
  note(`precheck ${TARGET}: ${pre.stdout.trim()}`);
  if (pre.stdout.trim() !== "ABSENT") throw new Error("target file already exists; aborting");

  // Launch xfce4-terminal (standalone process, known geometry). Read-only launch, no input yet.
  const launch = await sh(
    "setsid xfce4-terminal --disable-server --title=phase1-a3 --geometry=80x20+200+150 >/tmp/xfce4-terminal.log 2>&1 & echo $!",
  );
  note(`launched xfce4-terminal pid=${launch.stdout.trim()} exit=${launch.exitCode}`);

  // Wait (bounded) for its window to be mapped.
  let wid = "";
  for (let i = 0; i < 30 && !wid; i++) {
    const w = await sh("xdotool search --onlyvisible --class xfce4-terminal 2>/dev/null | tail -1");
    wid = w.stdout.trim();
    if (!wid) await sleep(500);
  }
  if (!wid) {
    const tl = await sh("cat /tmp/xfce4-terminal.log 2>&1 | tail -20");
    status = "FAIL";
    note(`xfce4-terminal window never mapped; terminal log: ${JSON.stringify(tl.stdout.trim())}`);
    return;
  }
  await sleep(1500); // let the shell inside print its prompt

  const geo = parseShell((await sh(`xdotool getwindowgeometry --shell ${wid}`)).stdout);
  const cx = Number(geo.X) + Math.floor(Number(geo.WIDTH) / 2);
  const cy = Number(geo.Y) + Math.floor(Number(geo.HEIGHT) / 2);
  note(`window ${wid} geometry X=${geo.X} Y=${geo.Y} W=${geo.WIDTH} H=${geo.HEIGHT} → click (${cx},${cy})`);

  const before = await sandbox.desktop.screenshot();
  writeFileSync(`${ART}/a3-before-click.png`, before.data);

  // Focus via desktop.click(), then verify focus before sending any keystrokes.
  await sandbox.desktop.click(cx, cy);
  await sleep(300);
  const focus = (await sh("xdotool getwindowfocus")).stdout.trim();
  const cur = parseShell((await sh("xdotool getmouselocation --shell")).stdout);
  note(`after click: focused window=${focus} (terminal=${wid}) cursor=(${cur.X},${cur.Y})`);
  if (focus !== wid) {
    status = "FAIL";
    note("terminal did not receive focus from desktop.click(); no keystrokes sent");
    const s = await sandbox.desktop.screenshot();
    writeFileSync(`${ART}/a3-focus-fail.png`, s.data);
    return;
  }

  // Type and execute the command via desktop keyboard input only. Single attempt, no retries.
  const token = `a3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const typed = `echo ${token} > ${TARGET}`;
  await sandbox.desktop.write(typed);
  await sandbox.desktop.press("enter");
  note(`desktop.write(${JSON.stringify(typed)}) + desktop.press("enter")`);

  // Bounded wait for the file to appear (read-only polling).
  let exists = false;
  for (let i = 0; i < 20 && !exists; i++) {
    exists = (await sh(`test -f ${TARGET} && echo Y || echo N`)).stdout.trim() === "Y";
    if (!exists) await sleep(250);
  }
  const after = await sandbox.desktop.screenshot();
  writeFileSync(`${ART}/a3-after-input.png`, after.data);

  const read = await sh(`cat ${TARGET}`);
  const writer = await sh(`stat -c 'owner=%U size=%s mtime=%y' ${TARGET} 2>&1`);
  note(`commands.run cat → exit=${read.exitCode} stdout=${JSON.stringify(read.stdout)} ${writer.stdout.trim()}`);
  status = read.exitCode === 0 && read.stdout === token + "\n" ? "PASS" : "FAIL";
  note(`expected ${JSON.stringify(token + "\n")} → ${status}`);
}

async function cleanup() {
  if (!sandboxId) return;
  try {
    await Sandbox.killById(sandboxId);
    let state = "unknown";
    try {
      const me = (await Sandbox.list({ metadata: META })).find((s) => s.id === sandboxId);
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
  status = "FAIL";
  console.error(`\nFATAL: ${e instanceof Error ? e.stack : e}`);
} finally {
  await cleanup();
  console.log(`\n[${status}] A3 click + keyboard input verified`);
  console.log(`Total wall time: ${elapsed()}`);
  writeFileSync(`${ART}/a3-results.json`, JSON.stringify({ sandboxId, cleanupOk, status, fatal: fatal ? String(fatal) : null, evidence }, null, 2));
  process.exitCode = fatal || !cleanupOk || status !== "PASS" ? 1 : 0;
}
