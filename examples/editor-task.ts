/**
 * The GUI text-editor task run by `pnpm example:agent`: the model opens a text
 * editor through the desktop, types a short document and saves it under the
 * desktop user's home directory.
 *
 * Superserve documents `superserve/desktop` as Ubuntu 24.04 with `xfce4`,
 * `xfce4-terminal` and Chrome, and names no text editor. So the script looks
 * for one in the VM with a read-only command before any model call, and
 * stops (without spending OpenAI usage) when none is installed, unless
 * `DEMO_SETUP_EDITOR=1` asks the script to install Mousepad first
 * (`installMousepad`).
 */
import type { SuperserveSandbox } from '../src/index.js';

export const DOC_TITLE = 'Mastra × Superserve';
/** In the desktop user's home (`/home/desktop`, the default user for commands too). */
export const DOC_PATH = '/home/desktop/mastra-superserve-demo.txt';

export interface GuiEditor {
  /** Executable name, checked with `command -v`. */
  bin: string;
  /** Name shown in the XFCE Applications menu and application finder. */
  name: string;
}

/** Editors to look for, most likely first (Mousepad is XFCE's own). */
export const GUI_EDITORS: readonly GuiEditor[] = [
  { bin: 'mousepad', name: 'Mousepad' },
  { bin: 'gnome-text-editor', name: 'Text Editor' },
  { bin: 'gedit', name: 'Text Editor (gedit)' },
  { bin: 'xed', name: 'Xed' },
  { bin: 'pluma', name: 'Pluma' },
  { bin: 'featherpad', name: 'FeatherPad' },
  { bin: 'leafpad', name: 'Leafpad' },
];

export interface EditorPreflight {
  /** First installed editor from `GUI_EDITORS`, or null when none is. */
  editor: GuiEditor | null;
  /** Whether the document already exists (it must not, or the check proves nothing). */
  docExists: boolean;
}

/** Read-only environment discovery: which editors are installed, and whether `path` exists. */
export async function preflightEditorTask(
  sandbox: Pick<SuperserveSandbox, 'executeCommand'>,
  path = DOC_PATH,
): Promise<EditorPreflight> {
  const bins = GUI_EDITORS.map((e) => e.bin).join(' ');
  // `path` is appended (shell-quoted) after `test -e`, whose status is the exit code.
  const { stdout, exitCode } = await sandbox.executeCommand(
    `for b in ${bins}; do command -v "$b" >/dev/null 2>&1 && echo "editor=$b"; done; test -e`,
    [path],
  );
  const found = new Set([...stdout.matchAll(/^editor=(\S+)$/gm)].map((m) => m[1]));
  return { editor: GUI_EDITORS.find((e) => found.has(e.bin)) ?? null, docExists: exitCode === 0 };
}

/** Upper bound for the whole Mousepad install (apt-get update + install), enforced inside the VM. */
export const EDITOR_SETUP_TIMEOUT_SECONDS = 240;
/** Client-side bound for the read-only capability probe. */
export const EDITOR_CHECK_TIMEOUT_MS = 30_000;
/** Pause before the single retry of a read-only request (`retryReadOnlyOnce`). */
export const READ_RETRY_DELAY_MS = 2_000;
/** Prefix of the status lines the install command prints (see `installMousepad`). */
export const SETUP_MARK = 'mastra-setup:';
/** Mousepad's editor launcher. `org.xfce.mousepad-settings.desktop` (its preferences dialog) does not count. */
export const MOUSEPAD_DESKTOP_ENTRY = '/usr/share/applications/org.xfce.mousepad.desktop';

/** The setup step that failed: the capability probe, the apt-get install, or the post-install check. */
export type EditorSetupStep = 'probe' | 'install' | 'verify';

/**
 * Why a setup step failed:
 * - `unsupported`: no apt-get or no root access in the VM.
 * - `apt-failed` / `apt-timeout`: apt-get itself exited non-zero, or hit the in-VM limit.
 * - `verify-failed`: the check ran, but the binary or menu entry is missing.
 * - `incomplete`: the install command returned without the status lines it
 *   prints last (e.g. the stream's final event had no exit code, which the SDK
 *   reports as 0); never treated as success.
 * - `network`: the request to Superserve got no response (connection refused/reset,
 *   DNS, TLS, a stale keep-alive socket); the VM may or may not have run the command.
 * - `disconnect`: the response (or the output stream) was cut off part-way.
 * - `command-timeout`: the SDK gave up waiting for the command.
 * - `vm-gone`, `aborted`, `provider-error`: anything else the provider reported.
 */
export type EditorSetupFailure =
  | 'unsupported'
  | 'apt-failed'
  | 'apt-timeout'
  | 'verify-failed'
  | 'incomplete'
  | 'network'
  | 'disconnect'
  | 'command-timeout'
  | 'vm-gone'
  | 'aborted'
  | 'provider-error';

export interface EditorSetupResult {
  ok: boolean;
  /** What happened, for a `[SETUP]` log line. */
  detail: string;
  /** Set when `ok` is false. */
  step?: EditorSetupStep;
  failure?: EditorSetupFailure;
}

/**
 * Strip anything private from an error message before it is logged: URLs
 * (data-plane hosts carry the sandbox id), host names, IP addresses, bearer
 * values and long token-like strings.
 */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 <redacted>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/(?<![\w:.])(?=[0-9a-f:]*[0-9a-f])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,8}(?![\w:])/gi, '<ip>')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\b/gi, '<host>')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '<redacted>');
}

/**
 * One line describing an error and its `cause` chain, outermost first, e.g.
 * `SandboxError[PROVIDER_ERROR]: Superserve executeCommand failed: Network error: fetch failed
 * <- TypeError: fetch failed <- SocketError[UND_ERR_SOCKET]: other side closed`.
 * Only names, string codes and redacted messages are included; never headers,
 * request options, stacks or the error's other properties.
 */
export function describeError(error: unknown, maxDepth = 6): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current != null; depth++) {
    if (!(current instanceof Error)) {
      parts.push(redact(String(current)).slice(0, 200));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const label = `${current.name}${typeof code === 'string' ? `[${code}]` : ''}`;
    parts.push(`${label}: ${redact(current.message).slice(0, 200)}`);
    if (current instanceof AggregateError && current.errors.length > 0) {
      parts.push(`(${current.errors.length} attempts: ${current.errors.slice(0, 3).map((e) => describeError(e, 1)).join('; ')})`);
    }
    current = current.cause;
  }
  return parts.join(' <- ');
}

/** Sort a thrown `executeCommand` error into the categories above (never apt or verify results). */
export function classifyCommandError(error: unknown): EditorSetupFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'TIMEOUT' || code === 'PROVIDER_TIMEOUT') return 'command-timeout';
  if (code === 'ABORTED') return 'aborted';
  if (code === 'SANDBOX_GONE') return 'vm-gone';
  const messages: string[] = [];
  for (let e: unknown = error, i = 0; e instanceof Error && i < 6; e = e.cause, i++) messages.push(e.message);
  const text = messages.join('\n');
  // The SDK's "Network error: …" (sync /exec) and "Stream error: …" (streamed
  // /exec/stream) wrap a rejected fetch. undici's "fetch failed" means no
  // response arrived; "terminated" means the body was cut off.
  if (/without a finished event|^terminated$/m.test(text) || /(Network|Stream) error: terminated/.test(text)) return 'disconnect';
  if (/(Network|Stream) error:|^fetch failed$/m.test(text)) return 'network';
  return 'provider-error';
}

type CommandOutcome = Awaited<ReturnType<SuperserveSandbox['executeCommand']>>;

/**
 * Run one named setup step. A thrown provider error becomes `{ error }` with
 * its category and a redacted cause chain, so the caller can report which
 * step failed and how, instead of a bare "fetch failed".
 */
async function runStep(
  step: EditorSetupStep,
  run: () => Promise<CommandOutcome>,
): Promise<{ result: CommandOutcome; error?: undefined } | { result?: undefined; error: { failure: EditorSetupFailure; cause: string; step: EditorSetupStep } }> {
  try {
    return { result: await run() };
  } catch (error) {
    return { error: { step, failure: classifyCommandError(error), cause: describeError(error) } };
  }
}

/**
 * Run a read-only request; if it fails in transit (`network` or `disconnect`),
 * log the redacted cause and run it once more. Any other error, or a second
 * failure, is thrown. Never use it for a command that changes the VM: a
 * request lost in transit may still have run.
 */
export async function retryReadOnlyOnce<T>(
  label: string,
  run: () => Promise<T>,
  log: (line: string) => void = () => {},
  delayMs = READ_RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const failure = classifyCommandError(error);
    if (failure !== 'network' && failure !== 'disconnect') throw error;
    log(`${label} request failed (${failure}): ${describeError(error)}; retrying once in ${delayMs / 1000}s (read-only)`);
    await new Promise((r) => setTimeout(r, delayMs));
    return run();
  }
}

/**
 * Demo-only setup (`DEMO_SETUP_EDITOR=1` or `DEMO_SETUP_ONLY=1`), run by the
 * script before the agent starts and never by the model: install Mousepad
 * with apt-get as root (directly, or through passwordless `sudo -n`), then
 * confirm the binary and its editor launcher (`MOUSEPAD_DESKTOP_ENTRY`)
 * exist. Returns `ok: false` with the failed step, a failure category and a
 * reason instead of throwing: no apt-get or root access, an apt-get failure or timeout, a failed check, a
 * command that ended without its status lines, or a Superserve request that
 * failed (network, disconnect, SDK timeout).
 *
 * Install and verification run in one streamed command, so no second request
 * can fail between them. Success is decided by the status lines that command
 * prints (`mastra-setup:apt_exit=0`, `bin=`, `entry=`, and `done` last), not by
 * the SDK's exit code alone. The install is never retried: a request that
 * failed in transit may still have run in the VM.
 */
export async function installMousepad(
  sandbox: Pick<SuperserveSandbox, 'executeCommand'>,
  log: (line: string) => void = () => {},
): Promise<EditorSetupResult> {
  const failed = (step: EditorSetupStep, failure: EditorSetupFailure, detail: string): EditorSetupResult => ({
    ok: false,
    step,
    failure,
    detail,
  });
  const requestFailed = (e: { step: EditorSetupStep; failure: EditorSetupFailure; cause: string }, note: string) =>
    failed(e.step, e.failure, `${e.step} request failed (${e.failure}): ${e.cause}. ${note}`);

  const probe = await runStep('probe', () =>
    sandbox.executeCommand(
      'command -v apt-get >/dev/null 2>&1 && echo apt=yes; [ "$(id -u)" = 0 ] && echo root=yes; sudo -n true >/dev/null 2>&1 && echo sudo=yes; true',
      [],
      { timeout: EDITOR_CHECK_TIMEOUT_MS },
    ),
  );
  if (probe.error) return requestFailed(probe.error, 'Nothing was installed.');
  const has = (key: string) => new RegExp(`^${key}=yes$`, 'm').test(probe.result.stdout);
  if (!has('apt')) return failed('probe', 'unsupported', 'apt-get is not available in this VM');
  const asRoot = has('root') ? '' : has('sudo') ? 'sudo -n ' : null;
  if (asRoot === null) return failed('probe', 'unsupported', 'no root access (not root, and passwordless sudo -n is refused)');
  log(`apt-get available; installing Mousepad as root via ${asRoot ? 'passwordless sudo' : 'the root user'} (limit ${EDITOR_SETUP_TIMEOUT_SECONDS}s)`);

  const m = SETUP_MARK;
  const script = [
    'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l',
    'apt-get -q -o DPkg::Lock::Timeout=60 update && apt-get -q -y -o DPkg::Lock::Timeout=60 install --no-install-recommends mousepad',
    's=$?',
    `echo "${m}apt_exit=$s"`,
    '[ "$s" = 0 ] || exit "$s"',
    // Verification, read-only, in the same command.
    `b=$(command -v mousepad); e=; [ -f ${MOUSEPAD_DESKTOP_ENTRY} ] && e=${MOUSEPAD_DESKTOP_ENTRY}`,
    `echo "${m}bin=$b"; echo "${m}entry=$e"`,
    '[ -n "$b" ] && [ -n "$e" ] || exit 3',
    `echo "${m}done"`,
  ].join('\n');
  const started = Date.now();
  const install = await runStep('install', () =>
    sandbox.executeCommand(`${asRoot}timeout -k 10 ${EDITOR_SETUP_TIMEOUT_SECONDS} sh -c`, [script], {
      timeout: (EDITOR_SETUP_TIMEOUT_SECONDS + 30) * 1000,
      // Streaming keeps the connection active while apt-get prints progress; output is still collected.
      onStdout: () => {},
    }),
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  if (install.error) {
    return requestFailed(install.error, `apt-get may or may not have run in the VM (not retried; ${seconds}s elapsed).`);
  }
  const { exitCode, stdout, stderr } = install.result;
  const mark = (key: string) => stdout.match(new RegExp(`^${m}${key}=(.*)$`, 'm'))?.[1]?.trim();
  const aptExit = mark('apt_exit');
  if (aptExit === undefined) {
    if (exitCode === 124 || exitCode === 137) {
      return failed('install', 'apt-timeout', `apt-get did not finish within ${EDITOR_SETUP_TIMEOUT_SECONDS}s`);
    }
    return failed(
      'install',
      'incomplete',
      `the install command returned exit ${exitCode} after ${seconds}s without reporting apt-get's status; not treated as success`,
    );
  }
  if (aptExit !== '0') {
    const output = (text: string) => text.split('\n').filter((l) => l.trim() && !l.startsWith(m));
    const lines = output(stderr).length ? output(stderr) : output(stdout);
    const tail = redact(lines.slice(-3).join(' | ')).slice(0, 400);
    return failed('install', 'apt-failed', `apt-get failed (exit ${aptExit}) after ${seconds}s: ${tail}`);
  }
  const evidence = /^Setting up mousepad\b/m.test(stdout)
    ? 'dpkg set up mousepad'
    : /mousepad is already the newest version/.test(stdout)
      ? 'mousepad was already installed'
      : 'no "Setting up mousepad" line in its output';
  log(`apt-get exited 0 in ${seconds}s (${evidence})`);

  const [bin, entry] = [mark('bin'), mark('entry')];
  // Only the editor launcher itself counts (not e.g. org.xfce.mousepad-settings.desktop).
  const launcher = entry === MOUSEPAD_DESKTOP_ENTRY;
  if (!bin || !launcher) {
    const missing = [!bin && 'mousepad is not on the PATH', !launcher && `no ${MOUSEPAD_DESKTOP_ENTRY}`].filter(Boolean);
    const what = bin === undefined && entry === undefined ? `the check printed nothing (exit ${exitCode})` : missing.join(' and ');
    return failed('verify', bin === undefined && entry === undefined ? 'incomplete' : 'verify-failed', `${what} after apt-get exited 0`);
  }
  if (!new RegExp(`^${m}done$`, 'm').test(stdout) || exitCode !== 0) {
    return failed('verify', 'incomplete', `the install command did not report completion (exit ${exitCode}); not treated as success`);
  }
  return { ok: true, detail: `Mousepad installed: ${bin}, menu entry ${entry} (verified in the same command)` };
}

/** The task given to the model. It names the editor but leaves every click and key to the model. */
export function editorTaskPrompt(editor: GuiEditor, token: string, path = DOC_PATH): string {
  return [
    'Task on the Linux (XFCE) desktop:',
    '1. Take a screenshot to see the desktop.',
    `2. Open the ${editor.name} text editor through the desktop: the "Applications" menu at the top left,`,
    '   or the application finder (magnifier icon in the bottom dock). Do not open it from a terminal or with execute_command.',
    "3. Click in the editor's text area so it has focus. With the type tool, type this line exactly:",
    `   ${DOC_TITLE}`,
    '   then press Enter with the key tool, and type this line exactly:',
    `   Verification token: ${token}`,
    '4. Save with ctrl+s. In the save dialog, type the full path into the file name field and press Enter:',
    `   ${path}`,
    '   Take a screenshot to confirm the save worked.',
    `5. Check with execute_command: cat ${path}`,
    'Do not create, modify or open the file with execute_command; use it only for that check.',
    'Finish with one line: "RESULT: <token>" or "FAILED: <reason>".',
  ].join('\n');
}

/** What the independent check found in the saved document. */
export function checkDocument(contents: string, token: string) {
  return { hasTitle: contents.includes(DOC_TITLE), hasToken: contents.includes(token) };
}

/**
 * Whether a shell command starts `bin` (directly, by path, after `;`/`&&`/`|`,
 * or behind `nohup`/`setsid`/`env`/`VAR=`), or opens anything through a
 * desktop launcher. Lookups such as `command -v mousepad` or
 * `pgrep -x mousepad` do not count.
 */
export function shellLaunches(command: string, bin: string): boolean {
  const name = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = String.raw`(?:^|[;&|(\n]|\$\()\s*(?:(?:sudo|nohup|setsid|exec|env|timeout\s+\S+)\s+|[A-Za-z_]\w*=\S*\s+)*`;
  return (
    new RegExp(`${prefix}(?:\\S*/)?${name}(?![\\w.-])`).test(command) ||
    /\b(xdg-open|exo-open|gtk-launch|gio\s+(open|launch))\b/.test(command)
  );
}
