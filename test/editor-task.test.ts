// The GUI text-editor demo task: editor discovery, prompt, shell checks, and the real agent loop.
import { SandboxError as SdkSandboxError } from '@superserve/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVm, type FakeVm } from './fakes.js';

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

const task = await import('../examples/editor-task.js');
const { createDesktopAgent, createDesktopWorkspace, shellWritesTo } = await import('../examples/desktop-agent.js');
const { scriptedModel } = await import('../examples/scripted-model.js');
const demo = await import('../examples/demo.js');
const { runSetupOnly } = await import('../examples/setup-only.js');

const TOKEN = 'mastra-openai-tok123';
const MOUSEPAD = { bin: 'mousepad', name: 'Mousepad' };

let vm: FakeVm;
/** Executables `command -v` finds, and whether the document exists, in the fake VM. */
let installed: string[];
let docContents: string | null;

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-editor');
  installed = ['mousepad'];
  docContents = null;
  sdk.create.mockResolvedValue(vm);
  sdk.list.mockResolvedValue([]);
  sdk.killById.mockResolvedValue(undefined);
  vm.commands.run.mockImplementation(async (command: string) => {
    const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0, truncated: false });
    if (command.startsWith('xdotool getmouselocation')) return ok('X=10\nY=20\nSCREEN=0\nWINDOW=1\n');
    if (command.startsWith('for b in ')) {
      const stdout = installed.map((b) => `editor=${b}\n`).join('');
      return { ...ok(stdout), exitCode: docContents === null ? 1 : 0 };
    }
    if (command.startsWith('cat ')) {
      return docContents === null ? { stdout: '', stderr: 'No such file', exitCode: 1, truncated: false } : ok(docContents);
    }
    return ok('');
  });
});

describe('preflightEditorTask (read-only editor discovery)', () => {
  it('picks the first installed editor in preference order and runs one read-only command', async () => {
    installed = ['gedit', 'mousepad'];
    const { sandbox } = createDesktopWorkspace();
    await expect(task.preflightEditorTask(sandbox)).resolves.toEqual({ editor: MOUSEPAD, docExists: false });
    const commands = vm.commands.run.mock.calls.map(([c]) => c as string);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^for b in mousepad gnome-text-editor gedit .*command -v "\$b".*; test -e \/home\/desktop\/mastra-superserve-demo\.txt$/);
    // The only redirect discards `command -v` output.
    expect(commands[0]!.replace('>/dev/null 2>&1', '')).not.toMatch(/apt|install|>|tee|touch|rm |mv |cp /);
  });

  it('reports no editor rather than assuming one, and an existing document', async () => {
    installed = [];
    docContents = 'old';
    const { sandbox } = createDesktopWorkspace();
    await expect(task.preflightEditorTask(sandbox)).resolves.toEqual({ editor: null, docExists: true });
  });

  it('shell-quotes a custom path', async () => {
    const { sandbox } = createDesktopWorkspace();
    await task.preflightEditorTask(sandbox, "/home/desktop/it's here.txt");
    expect(vm.commands.run.mock.calls[0]![0]).toMatch(/test -e '\/home\/desktop\/it'\\''s here\.txt'$/);
  });
});

describe('installMousepad (DEMO_SETUP_EDITOR, scripted before the agent)', () => {
  type Reply = { stdout?: string; stderr?: string; exitCode?: number };
  const M = 'mastra-setup:';
  /** stdout of a successful install + in-band verification. */
  const INSTALLED = `Setting up mousepad (0.6.1-1) ...\n${M}apt_exit=0\n${M}bin=/usr/bin/mousepad\n${M}entry=/usr/share/applications/org.xfce.mousepad.desktop\n${M}done\n`;
  /** Answer the capability probe and the (install + verify) command with the given replies. */
  function vmReplies(probe: string, install: Reply = { stdout: INSTALLED }) {
    vm.commands.run.mockImplementation(async (command: string) => {
      const reply = command.startsWith('command -v apt-get') ? { stdout: probe } : install;
      return { stdout: '', stderr: '', exitCode: 0, truncated: false, ...reply };
    });
  }
  const commands = () => vm.commands.run.mock.calls.map(([c]) => c as string);

  it('installs and verifies in one streamed command through passwordless sudo, bounded by a timeout', async () => {
    vmReplies('apt=yes\nsudo=yes\n');
    const { sandbox } = createDesktopWorkspace();
    const logs: string[] = [];
    await expect(task.installMousepad(sandbox, (l) => logs.push(l))).resolves.toEqual({
      ok: true,
      detail: 'Mousepad installed: /usr/bin/mousepad, menu entry /usr/share/applications/org.xfce.mousepad.desktop (verified in the same command)',
    });
    const [probe, install] = commands();
    expect(commands()).toHaveLength(2); // no separate verify request
    expect(probe).toContain('sudo -n true');
    expect(install).toMatch(/^sudo -n timeout -k 10 240 sh -c '/);
    expect(install).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(install).toContain('apt-get -q -y -o DPkg::Lock::Timeout=60 install --no-install-recommends mousepad');
    expect(install).toContain('command -v mousepad');
    expect(install).toContain('[ -f /usr/share/applications/org.xfce.mousepad.desktop ]');
    expect(install).not.toMatch(/grep -i -m1 mousepad/);
    expect(install).toContain(`echo "${M}done"`);
    // Setup installs Mousepad but never starts it; opening it is left to the agent's GUI actions.
    for (const c of commands()) expect(task.shellLaunches(c, 'mousepad')).toBe(false);
    const opts = vm.commands.run.mock.calls[1]![1] as { timeoutMs?: number; onStdout?: unknown };
    expect(opts.timeoutMs).toBe(270_000);
    expect(typeof opts.onStdout).toBe('function');
    expect(logs[0]).toMatch(/passwordless sudo/);
    expect(logs[1]).toMatch(/^apt-get exited 0 in \d+s \(dpkg set up mousepad\)$/);
  });

  it('runs apt-get directly when the command user is root', async () => {
    vmReplies('apt=yes\nroot=yes\nsudo=yes\n');
    const { sandbox } = createDesktopWorkspace();
    await expect(task.installMousepad(sandbox)).resolves.toMatchObject({ ok: true });
    expect(commands()[1]).toMatch(/^timeout -k 10 240 sh -c '/);
  });

  it.each([
    ['no apt-get', 'sudo=yes\n', /apt-get is not available/],
    ['no root access', 'apt=yes\n', /no root access/],
  ])('fails clearly without attempting an install when there is %s', async (_, probe, detail) => {
    vmReplies(probe);
    const { sandbox } = createDesktopWorkspace();
    const result = await task.installMousepad(sandbox);
    expect(result).toMatchObject({ ok: false, step: 'probe', failure: 'unsupported' });
    expect(result.detail).toMatch(detail);
    expect(commands()).toHaveLength(1);
  });

  it('reports a timeout and an apt-get failure with the end of its output', async () => {
    const { sandbox } = createDesktopWorkspace();
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 124, stdout: 'Get:1 ...\n' });
    await expect(task.installMousepad(sandbox)).resolves.toEqual({
      ok: false,
      step: 'install',
      failure: 'apt-timeout',
      detail: 'apt-get did not finish within 240s',
    });
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 100, stdout: `${M}apt_exit=100\n`, stderr: 'W: x\nE: Unable to locate package mousepad\n' });
    const failed = await task.installMousepad(sandbox);
    expect(failed).toMatchObject({ ok: false, step: 'install', failure: 'apt-failed' });
    expect(failed.detail).toMatch(/^apt-get failed \(exit 100\) after \d+s: W: x \| E: Unable to locate package mousepad$/);
  });

  it('trusts apt-get\'s printed status over the SDK exit code', async () => {
    const { sandbox } = createDesktopWorkspace();
    // The SDK reports 0 when the stream's final event has no exit code.
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 0, stdout: `${M}apt_exit=100\n`, stderr: 'E: dpkg was interrupted\n' });
    await expect(task.installMousepad(sandbox)).resolves.toMatchObject({ ok: false, failure: 'apt-failed' });
  });

  it.each([
    ['no status lines at all', 'Setting up mousepad (0.6.1-1) ...\n', 'install', /without reporting apt-get's status; not treated as success$/],
    ['apt status but no check output', `${M}apt_exit=0\n`, 'verify', /^the check printed nothing \(exit 0\) after apt-get exited 0$/],
    ['no completion line', INSTALLED.replace(`${M}done\n`, ''), 'verify', /did not report completion \(exit 0\); not treated as success$/],
  ])('does not treat exit 0 with %s as success', async (_, stdout, step, detail) => {
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 0, stdout });
    const { sandbox } = createDesktopWorkspace();
    const result = await task.installMousepad(sandbox);
    expect(result).toMatchObject({ ok: false, step, failure: 'incomplete' });
    expect(result.detail).toMatch(detail);
  });

  it('fails when the binary or menu entry is still missing afterwards, naming which', async () => {
    const { sandbox } = createDesktopWorkspace();
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 3, stdout: `${M}apt_exit=0\n${M}bin=\n${M}entry=\n` });
    await expect(task.installMousepad(sandbox)).resolves.toEqual({
      ok: false,
      step: 'verify',
      failure: 'verify-failed',
      detail: 'mousepad is not on the PATH and no /usr/share/applications/org.xfce.mousepad.desktop after apt-get exited 0',
    });
    vmReplies('apt=yes\nsudo=yes\n', { exitCode: 3, stdout: `${M}apt_exit=0\n${M}bin=/usr/bin/mousepad\n${M}entry=\n` });
    await expect(task.installMousepad(sandbox)).resolves.toMatchObject({
      detail: 'no /usr/share/applications/org.xfce.mousepad.desktop after apt-get exited 0',
    });
  });

  it.each(['org.xfce.mousepad-settings.desktop', '/usr/share/applications/org.xfce.mousepad-settings.desktop'])(
    'does not accept %s as the editor launcher',
    async (entry) => {
      const { sandbox } = createDesktopWorkspace();
      vmReplies('apt=yes\nsudo=yes\n', { stdout: INSTALLED.replace(`${M}entry=/usr/share/applications/org.xfce.mousepad.desktop`, `${M}entry=${entry}`) });
      await expect(task.installMousepad(sandbox)).resolves.toEqual({
        ok: false,
        step: 'verify',
        failure: 'verify-failed',
        detail: 'no /usr/share/applications/org.xfce.mousepad.desktop after apt-get exited 0',
      });
    },
  );

  it('never retries the install after a request failure', async () => {
    vm.commands.run.mockImplementation(async (command: string) => {
      if (command.startsWith('command -v apt-get')) return { stdout: 'apt=yes\nsudo=yes\n', stderr: '', exitCode: 0, truncated: false };
      throw new SdkSandboxError('Stream error: terminated', undefined, undefined, { cause: new TypeError('terminated') });
    });
    const { sandbox } = createDesktopWorkspace();
    const result = await task.installMousepad(sandbox);
    expect(result).toMatchObject({ ok: false, step: 'install', failure: 'disconnect' });
    expect(result.detail).toMatch(/apt-get may or may not have run in the VM \(not retried/);
    expect(commands()).toHaveLength(2);
  });
});

/** What the SDK throws when fetch rejects before a response: "Network error: fetch failed" with undici's cause. */
const fetchFailed = (socketMessage = 'other side closed') =>
  new SdkSandboxError('Network error: fetch failed', undefined, undefined, {
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error(socketMessage), { name: 'SocketError', code: 'UND_ERR_SOCKET' }),
    }),
  });

describe('retryReadOnlyOnce', () => {
  it('retries once after a network failure, logging the redacted cause', async () => {
    let calls = 0;
    const { sandbox } = createDesktopWorkspace();
    vm.commands.run.mockImplementationOnce(async () => {
      calls++;
      throw fetchFailed('getaddrinfo ENOTFOUND sbx-0123.data.superserve.example');
    });
    const logs: string[] = [];
    await expect(task.retryReadOnlyOnce('preflight', () => task.preflightEditorTask(sandbox), (l) => logs.push(l), 1)).resolves.toEqual({
      editor: MOUSEPAD,
      docExists: false,
    });
    expect(calls).toBe(1);
    expect(vm.commands.run).toHaveBeenCalledTimes(2);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^preflight request failed \(network\): SandboxError\[PROVIDER_ERROR\]: .*fetch failed <- SocketError\[UND_ERR_SOCKET\]: getaddrinfo ENOTFOUND <host>; retrying once/);
    expect(logs[0]).not.toContain('superserve.example');
  });

  it('gives up after the one retry', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('x', { cause: fetchFailed() }), { code: 'PROVIDER_ERROR' });
    });
    await expect(task.retryReadOnlyOnce('preflight', run, () => {}, 1)).rejects.toThrow('x');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures (SDK timeout)', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    });
    await expect(task.retryReadOnlyOnce('preflight', run, () => {}, 1)).rejects.toThrow('timed out');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('runSetupOnly (DEMO_SETUP_ONLY=1)', () => {
  const M = 'mastra-setup:';

  function setupVm(install: { stdout?: string; exitCode?: number }) {
    installed = [];
    vm.commands.run.mockImplementation(async (command: string) => {
      const ok = (stdout: string, exitCode = 0) => ({ stdout, stderr: '', exitCode, truncated: false });
      if (command.startsWith('command -v apt-get')) return ok('apt=yes\nsudo=yes\n');
      if (command.startsWith('for b in ')) return ok(installed.map((b) => `editor=${b}\n`).join(''), 1);
      if (command.includes('apt-get -q')) {
        if ((install.exitCode ?? 0) === 0 && install.stdout?.includes(`${M}done`)) installed = ['mousepad'];
        return ok(install.stdout ?? '', install.exitCode ?? 0);
      }
      return ok('');
    });
  }

  it('installs, verifies, prints [SETUP] PASS and destroys the VM, without any fetch (no OpenAI)', async () => {
    setupVm({ stdout: `${M}apt_exit=0\n${M}bin=/usr/bin/mousepad\n${M}entry=/usr/share/applications/org.xfce.mousepad.desktop\n${M}done\n` });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logs: string[] = [];
    await expect(runSetupOnly({}, (l) => logs.push(l))).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(logs).toContain('[ENV] Before setup: no GUI text editor found');
    expect(logs.some((l) => l.startsWith('[SETUP] PASS'))).toBe(true);
    expect(logs.at(-2)).toMatch(/^\[VM\] Destroyed/);
    expect(logs.at(-1)).toBe('[RESULT] PASS');
    expect(sdk.killById).toHaveBeenCalledTimes(1);
    // probe/preflight/install only: nothing starts mousepad or touches the desktop.
    for (const [c] of vm.commands.run.mock.calls) expect(task.shellLaunches(c as string, 'mousepad')).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('prints the failure and still destroys the VM', async () => {
    setupVm({ stdout: `${M}apt_exit=0\n`, exitCode: 0 });
    const logs: string[] = [];
    await expect(runSetupOnly({}, (l) => logs.push(l))).resolves.toBe(1);
    expect(logs).toContain('[SETUP] FAIL at verify (incomplete): the check printed nothing (exit 0) after apt-get exited 0');
    expect(sdk.killById).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toBe('[RESULT] FAIL');
  });

  it('reports a thrown error with its phase and still destroys the VM', async () => {
    setupVm({});
    vm.commands.run.mockRejectedValue(Object.assign(new Error('boom'), { code: 'X' }));
    const logs: string[] = [];
    await expect(runSetupOnly({}, (l) => logs.push(l))).resolves.toBe(1);
    expect(logs.some((l) => l.startsWith('[SETUP] FAIL during editor preflight: '))).toBe(true);
    expect(sdk.killById).toHaveBeenCalledTimes(1);
  });
});

describe('error diagnostics', () => {
  it('redacts URLs, hosts, addresses and tokens', () => {
    expect(task.redact('POST https://sbx-1.superserve.ai/exec?t=abc failed')).toBe('POST <url> failed');
    expect(task.redact('connect ECONNREFUSED 10.1.2.3:443')).toBe('connect ECONNREFUSED <ip>');
    expect(task.redact('connect ENETUNREACH 2606:4700::6810:84e5:443')).toBe('connect ENETUNREACH <ip>');
    expect(task.redact('Authorization: Bearer sk-live-123')).toBe('Authorization: Bearer <redacted>');
    expect(task.redact(`key ${'a1'.repeat(20)}`)).toBe('key <redacted>');
    expect(task.redact('E: Unable to locate package mousepad')).toBe('E: Unable to locate package mousepad');
  });

  it('classifies thrown errors', () => {
    const wrap = (cause: unknown, code = 'PROVIDER_ERROR') => Object.assign(new Error('x', { cause }), { code });
    expect(task.classifyCommandError(wrap(new SdkSandboxError('Network error: fetch failed')))).toBe('network');
    expect(task.classifyCommandError(wrap(new SdkSandboxError('Network error: terminated')))).toBe('disconnect');
    expect(task.classifyCommandError(wrap(new SdkSandboxError('Command stream ended without a finished event (possible network disconnect)')))).toBe('disconnect');
    expect(task.classifyCommandError(wrap(undefined, 'TIMEOUT'))).toBe('command-timeout');
    expect(task.classifyCommandError(wrap(undefined, 'SANDBOX_GONE'))).toBe('vm-gone');
    expect(task.classifyCommandError(wrap(new Error('boom')))).toBe('provider-error');
  });
});

describe('editorTaskPrompt', () => {
  const prompt = task.editorTaskPrompt(MOUSEPAD, TOKEN);

  it('asks for the editor, the title, the token and the save path', () => {
    expect(prompt).toContain('Open the Mousepad text editor through the desktop');
    expect(prompt).toContain('Mastra × Superserve');
    expect(prompt).toContain(`Verification token: ${TOKEN}`);
    expect(prompt).toContain(task.DOC_PATH);
    expect(task.DOC_PATH.startsWith('/home/desktop/')).toBe(true);
  });

  it('forbids shell launching and shell writes, and gives the model no coordinates', () => {
    expect(prompt).toContain('Do not open it from a terminal or with execute_command');
    expect(prompt).toContain('Do not create, modify or open the file with execute_command');
    expect(prompt).not.toMatch(/\(\s*\d+\s*,\s*\d+\s*\)|\bx\s*=\s*\d|\bat \d+/);
  });
});

describe('checkDocument', () => {
  it.each([
    [`Mastra × Superserve\nVerification token: ${TOKEN}\n`, { hasTitle: true, hasToken: true }],
    [`Verification token: ${TOKEN}`, { hasTitle: false, hasToken: true }],
    [`Mastra x Superserve\n${TOKEN}`, { hasTitle: false, hasToken: true }], // × typed wrong
    ['Mastra × Superserve\nVerification token: mastra-openai-other', { hasTitle: true, hasToken: false }],
    ['', { hasTitle: false, hasToken: false }],
  ])('%j', (contents, expected) => expect(task.checkDocument(contents, TOKEN)).toEqual(expected));
});

describe('shellLaunches (demo check that the editor was not started from the shell)', () => {
  it.each([
    'mousepad',
    'mousepad /home/desktop/mastra-superserve-demo.txt &',
    '/usr/bin/mousepad',
    'DISPLAY=:0 mousepad',
    'nohup setsid mousepad >/dev/null 2>&1 &',
    'cd ~ && mousepad x.txt',
    'echo hi; env DISPLAY=:0 mousepad',
    'xdg-open /home/desktop/mastra-superserve-demo.txt',
    'exo-open --launch TextEditor',
    'gtk-launch org.xfce.mousepad',
  ])('flags %s', (command) => expect(task.shellLaunches(command, 'mousepad')).toBe(true));

  it.each([
    'command -v mousepad',
    'which mousepad',
    'pgrep -x mousepad',
    'ps aux | grep mousepad',
    'cat /home/desktop/mastra-superserve-demo.txt',
    'cat /home/desktop/mousepad-notes.txt',
    'ls /usr/share/applications | grep -i mousepad',
  ])('ignores %s', (command) => expect(task.shellLaunches(command, 'mousepad')).toBe(false));
});

describe('GUI editor workflow through the real Mastra agent loop', () => {
  it('routes screenshot, click, type and key calls to the desktop; the shell only reads', async () => {
    const order: string[] = [];
    vm.desktop.click.mockImplementation(async (...[x, y]: unknown[]) => void order.push(`click ${x},${y}`));
    vm.desktop.write.mockImplementation(async (...[text]: unknown[]) => void order.push(`write ${text}`));
    vm.desktop.press.mockImplementation(async (...[key]: unknown[]) => void order.push(`press ${JSON.stringify(key)}`));
    const { workspace } = createDesktopWorkspace(
      {},
      {
        mastra_workspace_computer_click: { screenshotDelayMs: 0 },
        mastra_workspace_computer_type: { screenshotDelayMs: 0 },
        mastra_workspace_computer_press_key: { screenshotDelayMs: 0 },
      },
    );
    const call = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ toolName: `mastra_workspace_computer_${name}`, input }] });
    const agent = createDesktopAgent(
      workspace,
      scriptedModel([
        call('screenshot', {}),
        call('click', { x: 40, y: 12 }), // Applications menu (the model's choice)
        call('click', { x: 120, y: 90 }), // Mousepad entry
        call('click', { x: 600, y: 400 }), // text area
        call('type', { text: 'Mastra × Superserve' }),
        call('press_key', { key: 'Enter' }),
        call('type', { text: `Verification token: ${TOKEN}` }),
        call('press_key', { key: 'ctrl+s' }),
        call('type', { text: task.DOC_PATH }),
        call('press_key', { key: 'Enter' }),
        { toolCalls: [{ toolName: 'mastra_workspace_execute_command', input: { command: `cat ${task.DOC_PATH}` } }] },
        { text: `RESULT: ${TOKEN}` },
      ]),
    );

    const logged: string[] = [];
    const result = await agent.generate(task.editorTaskPrompt(MOUSEPAD, TOKEN), {
      maxSteps: 15,
      onChunk: demo.createToolCallLogger((l) => logged.push(l)),
    });
    await workspace.destroy();

    expect(result.text).toBe(`RESULT: ${TOKEN}`);
    expect(vm.desktop.screenshot).toHaveBeenCalled();
    expect(order).toEqual([
      'click 40,12',
      'click 120,90',
      'click 600,400',
      'write Mastra × Superserve',
      'press ["Return"]',
      `write Verification token: ${TOKEN}`,
      'press ["ctrl","s"]',
      `write ${task.DOC_PATH}`,
      'press ["Return"]',
    ]);
    // Every shell command the run issued is read-only: none writes the document or starts the editor.
    const shell = vm.commands.run.mock.calls.map(([c]) => c as string);
    expect(shell.some((c) => c.startsWith('cat '))).toBe(true);
    for (const c of shell) {
      expect(shellWritesTo(c, task.DOC_PATH)).toBe(false);
      expect(task.shellLaunches(c, 'mousepad')).toBe(false);
    }
    // The live log shows lengths, never the document text or token.
    expect(logged).toContain('[AGENT] computer_type (19 chars)');
    expect(logged).toContain('[AGENT] computer_press_key ctrl+s');
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(task.DOC_PATH);
  });
});
