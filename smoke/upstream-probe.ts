// Phase 4A upstream probe: @superserve/sdk only (no Mastra adapter), one
// superserve/desktop VM, always killed. Classifies file ownership, command
// timeout and lifecycle behaviour as Superserve's or ours.
// Secrets are only ever tested for presence (booleans); never printed.
import { Sandbox } from "@superserve/sdk";
import { inspect } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";

const PURPOSE = "mastra-superserve-phase4a-upstream-probe";
const KEY = process.env.SUPERSERVE_API_KEY ?? "";
if (!KEY) throw new Error("SUPERSERVE_API_KEY not set");

type Row = { id: string; what: string; observed: string };
const rows: Row[] = [];
const note = (id: string, what: string, observed: string) => {
  rows.push({ id, what, observed });
  console.log(`[${id}] ${what}\n      → ${observed}`);
};
const t0 = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) => (KEY ? s.split(KEY).join("<redacted>") : s);

function describeError(e: unknown): string {
  if (!(e instanceof Error)) return `non-error ${redact(String(e))}`;
  const x = e as Error & { statusCode?: number; code?: string };
  return `${x.constructor.name} status=${x.statusCode ?? "-"} code=${x.code ?? "-"} msg="${redact(x.message).slice(0, 160)}"`;
}
async function measure<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const s = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - s, value };
  } catch (error) {
    return { ms: Date.now() - s, error };
  }
}
const outcome = (r: { ms: number; value?: { exitCode: number; stdout: string; stderr: string }; error?: unknown }) =>
  r.error
    ? `THREW after ${r.ms}ms: ${describeError(r.error)}`
    : `returned after ${r.ms}ms: exit=${r.value!.exitCode} stdout=${JSON.stringify(r.value!.stdout.trim().slice(0, 80))} stderr=${JSON.stringify(r.value!.stderr.trim().slice(0, 120))}`;

let sandbox: Sandbox | undefined;
let sandboxId: string | undefined;
let killedInTest = false;
let cleanupState = "not-run";

async function main() {
  sandbox = await Sandbox.create({
    name: `mastra-phase4a-probe-${Date.now()}`,
    fromTemplate: "superserve/desktop",
    timeoutSeconds: 600,
    autoDeleteSeconds: 300,
    metadata: { purpose: PURPOSE },
  });
  sandboxId = sandbox.id;
  console.log(`sandbox ${sandboxId} status=${sandbox.status} (${Date.now() - t0}ms)`);
  const sb = sandbox;
  const sh = (cmd: string) => sb.commands.run(cmd, { timeoutMs: 20_000 });
  const line = async (cmd: string) => {
    const r = await sh(cmd);
    return `exit=${r.exitCode} ${JSON.stringify((r.stdout + r.stderr).trim().replace(/\n/g, " | ").slice(0, 220))}`;
  };

  // ---------------- K: credential exposure (booleans only) ----------------
  note("K1", "enumerable own keys of a Sandbox instance", Object.keys(sb).join(","));
  note("K2", "JSON.stringify(sandbox) contains the API key", String(JSON.stringify(sb).includes(KEY)));
  note("K3", "util.inspect(sandbox) contains the API key", String(inspect(sb, { depth: 4 }).includes(KEY)));
  const token = (sb as unknown as { _accessToken?: string })._accessToken ?? "";
  note("K4", "JSON.stringify(sandbox) contains the per-VM access token", String(!!token && JSON.stringify(sb).includes(token)));

  // ---------------- O: ownership ----------------
  note("O0", "command identity, umask, sudo", await line("id; umask; stat -c '%n %U:%G %a' /home/desktop /tmp; sudo -n true 2>&1 && echo SUDO_NOPASSWD_OK"));

  const D = "/home/desktop/ss-probe/nested";
  await sb.files.write(`${D}/a.txt`, "from-files-write\n");
  note("O1", "files.write into a NEW nested dir under $HOME: owners/modes", await line(`stat -c '%n %U:%G %a' ${D}/a.txt ${D} /home/desktop/ss-probe`));
  note("O2", "command user appends to that file", await line(`echo more >> ${D}/a.txt`));
  note("O3", "command user edits it in place (sed -i)", await line(`sed -i 's/files/edit/' ${D}/a.txt`));
  note("O4", "command user renames it", await line(`mv ${D}/a.txt ${D}/b.txt`));
  note("O5", "command user deletes it", await line(`rm -f ${D}/a.txt; test -e ${D}/a.txt && echo STILL_EXISTS`));
  note("O6", "command user creates a sibling file in the dir files.write created", await line(`touch ${D}/sibling.txt`));

  await sb.files.write("/home/desktop/direct.txt", "direct\n");
  note("O7a", "files.write directly into $HOME (dir owned by desktop): owner/mode", await line("stat -c '%n %U:%G %a' /home/desktop/direct.txt"));
  note("O7b", "  append to it", await line("echo more >> /home/desktop/direct.txt"));
  note("O7c", "  sed -i it (replaces the inode) then owner", await line("sed -i 's/direct/edited/' /home/desktop/direct.txt && stat -c '%U:%G %a' /home/desktop/direct.txt"));

  await sb.files.write("/tmp/ss-probe-tmp.txt", "tmp\n");
  note("O8", "files.write into sticky /tmp, then command user appends + deletes", await line("stat -c '%U:%G %a' /tmp/ss-probe-tmp.txt; echo x >> /tmp/ss-probe-tmp.txt; rm -f /tmp/ss-probe-tmp.txt; test -e /tmp/ss-probe-tmp.txt && echo STILL_EXISTS"));

  await sh("echo by-command > /home/desktop/cmd.txt");
  await sb.files.write("/home/desktop/cmd.txt", "overwritten-by-files-write\n");
  note("O9", "files.write overwriting a command-created file: owner kept?", await line("stat -c '%U:%G %a' /home/desktop/cmd.txt; cat /home/desktop/cmd.txt; echo more >> /home/desktop/cmd.txt && echo APPEND_OK"));

  await sh("umask 077; echo secret > /home/desktop/private.txt");
  const priv = await measure(() => sb.files.readText("/home/desktop/private.txt"));
  note("O10", "files.read of a 0600 desktop-owned file", priv.error ? describeError(priv.error) : `read ${JSON.stringify(priv.value!.trim())}`);

  note("O11", "workaround: sudo -n chown, then append", await line(`sudo -n chown -R desktop:desktop /home/desktop/ss-probe && echo more >> ${D}/a.txt && stat -c '%U:%G' ${D}/a.txt`));

  // ---------------- T: command timeouts ----------------
  note("T1", "timeoutMs 1500 on `sleep 5` (server should kill, exit 124)", outcome(await measure(() => sb.commands.run("sleep 5; echo late", { timeoutMs: 1500 }))));
  note("T2", "`exit 124` with no timeout — same signal as a timeout", outcome(await measure(() => sh("exit 124"))));

  const t3 = await measure(() => sb.commands.run("sleep 12.31", { timeoutMs: 0 }));
  note("T3", "timeoutMs: 0 on `sleep 12.31`", outcome(t3));
  note("T3b", "  is `sleep 12.31` still running in the VM after the client gave up?", await line("pgrep -af 'sleep 12.31' || echo NOT_RUNNING"));

  console.log("… T4/T5: two 41 s sleeps with no timeoutMs (sync + streaming), concurrently; ~35 s");
  const [t4, t5] = await Promise.all([
    measure(() => sb.commands.run("sleep 41.17")),
    measure(() => sb.commands.run("sleep 41.19", { onStdout: () => {} })),
  ]);
  note("T4", "no timeoutMs, sync `sleep 41.17` (server default 30 s, client default 30 s)", outcome(t4));
  note("T5", "no timeoutMs, streaming `sleep 41.19`", outcome(t5));

  const t6 = await measure(() => sb.commands.run("echo hi", { timeoutMs: 2 ** 31 }));
  note("T6", "timeoutMs 2^31 (Node setTimeout overflow) on `echo hi`", outcome(t6));

  // ---------------- L: lifecycle ----------------
  const p1 = await measure(() => sb.pause({ wait: true, timeoutMs: 120_000 }));
  note("L1", "pause({wait}) of an idle VM", p1.error ? describeError(p1.error) : `ok after ${p1.ms}ms`);
  const conc = await measure(() => Promise.all([1, 2, 3, 4].map((n) => sb.commands.run(`echo c${n}`, { timeoutMs: 30_000 }))));
  note("L2", "4 concurrent commands on the paused VM (transparent resume)", conc.error ? `THREW after ${conc.ms}ms: ${describeError(conc.error)}` : `ok after ${conc.ms}ms: ${conc.value!.map((r) => r.stdout.trim()).join(",")}`);

  const inflight = measure(() => sb.commands.run("sleep 6; echo survived", { timeoutMs: 30_000 }));
  await sleep(1500);
  const p2 = await measure(() => sb.pause({ wait: true, timeoutMs: 120_000 }));
  const inflightResult = await Promise.race([inflight, sleep(60_000).then(() => ({ ms: 60_000, error: new Error("still pending after 60s") }))]);
  note("L3", "pause while `sleep 6` is in flight: pause result", p2.error ? describeError(p2.error) : `ok after ${p2.ms}ms`);
  note("L3b", "  … and the in-flight command", outcome(inflightResult as never));
  note("L3c", "  status after", (await sb.getInfo()).status);

  const doomed = measure(() => sb.commands.run("sleep 30", { timeoutMs: 40_000 }));
  await sleep(2000);
  await Sandbox.killById(sb.id);
  killedInTest = true;
  note("L4", "killById while `sleep 30` is in flight: the in-flight command", outcome(await doomed));
  note("L5", "commands.run after kill", outcome(await measure(() => sb.commands.run("true", { timeoutMs: 10_000 }))));
  const gi = await measure(() => sb.getInfo());
  note("L6", "getInfo after kill", gi.error ? describeError(gi.error) : `status=${gi.value!.status}`);
  const k2 = await measure(() => Sandbox.killById(sb.id));
  note("L7", "second killById (idempotent?)", k2.error ? describeError(k2.error) : `ok after ${k2.ms}ms`);
  for (const r of [t3, t4, t5, t6, inflightResult, gi, k2] as { error?: unknown }[]) {
    if (r.error && (JSON.stringify(r.error).includes(KEY) || inspect(r.error, { depth: 6 }).includes(KEY))) {
      note("K5", "an SDK error object contains the API key", "true");
    }
  }
}

async function cleanup() {
  if (!sandboxId) return;
  try {
    if (!killedInTest) await Sandbox.killById(sandboxId);
  } catch (e) {
    console.error(`killById during cleanup: ${describeError(e)}`);
  }
  try {
    const list = await Sandbox.list({ metadata: { purpose: PURPOSE } });
    const me = list.find((s) => s.id === sandboxId);
    cleanupState = me ? me.status : "absent from list";
  } catch (e) {
    cleanupState = `list failed: ${describeError(e)}`;
  }
  console.log(`CLEANUP ${sandboxId}: ${cleanupState}`);
}

const watchdog = setTimeout(async () => {
  console.error("WATCHDOG: 6 min elapsed — cleaning up");
  await cleanup();
  process.exit(2);
}, 6 * 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(130);
  });
}
let fatal: unknown;
try {
  await main();
} catch (e) {
  fatal = e;
  console.error(`FATAL: ${describeError(e)}`);
} finally {
  await cleanup();
  clearTimeout(watchdog);
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/upstream-probe.json",
    JSON.stringify({ sdk: "0.11.4", sandboxId, cleanupState, fatal: fatal ? describeError(fatal) : null, rows }, null, 2),
  );
  console.log(`wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = fatal || !["deleted", "absent from list"].includes(cleanupState) ? 1 : 0;
}
