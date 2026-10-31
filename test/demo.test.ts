// DEMO_MODE helpers: live tool-call logging, the scripted persistence showcase, and the viewer redirect.
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const demo = await import('../examples/demo.js');
const { createDesktopAgent, createDesktopWorkspace } = await import('../examples/desktop-agent.js');
const { scriptedModel } = await import('../examples/scripted-model.js');
const { SANDBOX_ID_METADATA_KEY } = await import('../src/index.js');

const TOKEN = 'mastra-openai-tok123';
const TARGET = '/tmp/mastra-agent-demo.txt';
const FAST_POLL = { attempts: 3, intervalMs: 1 };

let vm: FakeVm;
/** What the control plane lists; a deleted VM disappears. */
let rows: ReturnType<typeof listRow>[];
let fileContents: string | null;

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-demo-1234567890');
  rows = [];
  fileContents = `${TOKEN}\n`;
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
  });
  vm.commands.run.mockImplementation(async (command: string) => {
    if (command.startsWith('xdotool getmouselocation')) {
      return { stdout: 'X=10\nY=20\nSCREEN=0\nWINDOW=1\n', stderr: '', exitCode: 0, truncated: false };
    }
    if (command.startsWith('cat ')) {
      return fileContents === null
        ? { stdout: '', stderr: 'No such file', exitCode: 1, truncated: false }
        : { stdout: fileContents, stderr: '', exitCode: 0, truncated: false };
    }
    return { stdout: '', stderr: '', exitCode: 0, truncated: false };
  });
});

describe('formatToolCall (live [AGENT] lines)', () => {
  it.each([
    ['mastra_workspace_computer_screenshot', {}, '[AGENT] computer_screenshot'],
    ['mastra_workspace_computer_click', { x: 512, y: 740 }, '[AGENT] computer_click (512, 740)'],
    ['mastra_workspace_computer_double_click', { x: 1, y: 2 }, '[AGENT] computer_double_click (1, 2)'],
    ['mastra_workspace_computer_drag', { startX: 1, startY: 2, endX: 3, endY: 4 }, '[AGENT] computer_drag (1, 2) -> (3, 4)'],
    ['mastra_workspace_computer_press_key', { key: 'Enter' }, '[AGENT] computer_press_key Enter'],
    ['mastra_workspace_computer_press_key', { key: ['ctrl', 'alt', 't'] }, '[AGENT] computer_press_key ctrl+alt+t'],
    ['mastra_workspace_computer_scroll', { direction: 'down', amount: 3 }, '[AGENT] computer_scroll down 3'],
    ['mastra_workspace_computer_wait', { seconds: 2 }, '[AGENT] computer_wait 2s'],
    ['mastra_workspace_computer_type', { text: 'echo hunter2 > /tmp/x' }, '[AGENT] computer_type (21 chars)'],
    ['mastra_workspace_execute_command', { command: 'cat ~/.secret-token' }, '[AGENT] execute_command'],
    ['some_other_tool', { apiKey: 'sk-live-123' }, '[AGENT] some_other_tool'],
  ])('%s %j', (name, args, line) => expect(demo.formatToolCall(name, args)).toBe(line));

  it('never echoes unexpected key text or non-numeric coordinates', () => {
    expect(demo.formatToolCall('mastra_workspace_computer_press_key', { key: 'https://x.invalid/?token=abc' })).toBe(
      '[AGENT] computer_press_key ?',
    );
    expect(demo.formatToolCall('mastra_workspace_computer_click', { x: 'sk-live', y: null })).toBe('[AGENT] computer_click (?, ?)');
  });
});

describe('createToolCallLogger with the real Mastra agent loop', () => {
  it('logs each call as it starts, before it reaches the VM, and never prints args, results or image bytes', async () => {
    const events: string[] = [];
    const log = (line: string) => events.push(line);
    vm.desktop.click.mockImplementation(async () => void events.push('vm:click'));
    vm.desktop.write.mockImplementation(async () => void events.push('vm:type'));
    vm.desktop.doubleClick.mockRejectedValue(new Error(`boom https://6080-vm.invalid/?token=${TOKEN}`));
    const { workspace } = createDesktopWorkspace({}, { mastra_workspace_computer_click: { screenshotDelayMs: 0 } });
    const agent = createDesktopAgent(
      workspace,
      scriptedModel([
        { toolCalls: [{ toolName: 'mastra_workspace_computer_screenshot', input: {} }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_click', input: { x: 100, y: 200 } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_type', input: { text: `echo ${TOKEN} > ${TARGET}` } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_press_key', input: { key: 'Enter' } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_execute_command', input: { command: `cat ${TARGET}` } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_click', input: { x: -5, y: 1 } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_double_click', input: { x: 7, y: 8 } }] },
        { text: 'done' },
      ]),
    );

    const text = `echo ${TOKEN} > ${TARGET}`;
    await agent.generate('go', { maxSteps: 9, onChunk: demo.createToolCallLogger(log) });
    await workspace.destroy();

    expect(events).toEqual([
      '[AGENT] computer_screenshot',
      '[AGENT] computer_click (100, 200)',
      'vm:click',
      `[AGENT] computer_type (${text.length} chars)`,
      'vm:type',
      '[AGENT] computer_press_key Enter',
      '[AGENT] execute_command',
      '[AGENT] computer_click (-5, 1)',
      '[AGENT] computer_click failed', // rejected input
      '[AGENT] computer_double_click (7, 8)',
      '[AGENT] computer_double_click failed', // provider error
    ]);
    const all = events.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TARGET);
    expect(all).not.toMatch(/base64|iVBOR|https?:/);
  });
});

describe('showcasePersistence (scripted pause → new instance → reattach)', () => {
  async function agentRan() {
    const first = createDesktopWorkspace({ namePrefix: 'demo' });
    await first.sandbox.start();
    return first;
  }

  it('pauses, reattaches a new instance to the same VM as adopted, verifies state, then cleanup deletes it', async () => {
    const { sandbox, workspace } = await agentRan();
    const lines: string[] = [];
    let restored: Parameters<Parameters<typeof demo.showcasePersistence>[0]['onRestored']>[0] | undefined;
    const shots: Uint8Array[] = [];

    const ok = await demo.showcasePersistence({
      sandbox,
      workspace,
      target: TARGET,
      expected: TOKEN,
      sandboxOptions: { namePrefix: 'demo', timeoutSeconds: 600 },
      onRestored: (r) => (restored = r),
      onScreenshot: (png) => shots.push(png),
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });

    expect(ok).toBe(true);
    expect(vm.pause).toHaveBeenCalledWith(expect.objectContaining({ wait: true }));
    expect(sandbox.status).toBe('stopped');
    expect(restored).toBeDefined();
    expect(restored!.sandbox).not.toBe(sandbox);
    expect(restored!.sandbox.id).toBe(sandbox.id); // same logical owner
    expect(restored!.sandbox.sandboxId).toBe(vm.id);
    expect(restored!.sandbox.ownership).toBe('adopted');
    expect(sdk.create).toHaveBeenCalledTimes(1); // never a replacement VM
    expect(sdk.connect).toHaveBeenCalledWith(vm.id, {});
    expect(shots).toHaveLength(1);
    expect(lines).toEqual([
      `[VM] File verified: ${TARGET}`,
      '[VM] Paused (Superserve reports: paused)',
      '[VM] New provider instance created from saved sandboxId vm-demo-',
      '[VM] Reconnected to same sandbox vm-demo- (ownership: adopted)',
      `[VM] State preserved: ${TARGET} still holds the agent's token`,
      '[VM] Desktop responsive: 1280x800 screenshot, cursor at (10, 20)',
    ]);

    const status = await demo.destroyAndConfirm([restored!.workspace, workspace], vm.id, sandbox.id, FAST_POLL);
    expect(status).toBe('absent');
    expect(sdk.killById).toHaveBeenCalledWith(vm.id, {});
    expect(restored!.sandbox.status).toBe('destroyed');
    expect(sandbox.status).toBe('destroyed');
  });

  it('accepts a saved editor document that contains the token among other lines', async () => {
    const { sandbox, workspace } = await agentRan();
    fileContents = `Mastra × Superserve\nVerification token: ${TOKEN}\n`;
    const lines: string[] = [];
    const ok = await demo.showcasePersistence({
      sandbox,
      workspace,
      target: '/home/desktop/mastra-superserve-demo.txt',
      expected: TOKEN,
      onRestored: () => {},
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });
    expect(ok).toBe(true);
    expect(lines).toContain("[VM] State preserved: /home/desktop/mastra-superserve-demo.txt still holds the agent's token");
  });

  it('stops before pausing when the document lacks the token', async () => {
    const { sandbox, workspace } = await agentRan();
    fileContents = 'Mastra × Superserve\nVerification token: someone-else\n';
    const lines: string[] = [];
    const ok = await demo.showcasePersistence({
      sandbox,
      workspace,
      target: TARGET,
      expected: TOKEN,
      onRestored: () => {},
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });
    expect(ok).toBe(false);
    expect(lines).toEqual(['[VM] FAILED: file check before pause (exit 0)']);
    expect(vm.pause).not.toHaveBeenCalled();
  });

  it('reports a failed step when the file did not survive', async () => {
    const { sandbox, workspace } = await agentRan();
    const lines: string[] = [];
    vm.pause.mockImplementation(async () => {
      for (const r of rows) r.status = 'paused';
      fileContents = null;
    });
    const ok = await demo.showcasePersistence({
      sandbox,
      workspace,
      target: TARGET,
      expected: TOKEN,
      onRestored: () => {},
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });
    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe('[VM] FAILED: file check after reattach (exit 1)');
  });

  it('fails without reattaching when the control plane never reports paused', async () => {
    const { sandbox, workspace } = await agentRan();
    const lines: string[] = [];
    vm.pause.mockResolvedValue(undefined); // VM stays 'active' in the list
    const onRestored = vi.fn();
    const ok = await demo.showcasePersistence({
      sandbox,
      workspace,
      target: TARGET,
      expected: TOKEN,
      onRestored,
      log: (l) => lines.push(l),
      poll: FAST_POLL,
    });
    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe('[VM] FAILED: pause (provider stopped, VM active)');
    expect(onRestored).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('vmStatus asks the control plane by logical-id tag and treats unlisted VMs as absent', async () => {
    rows = [listRow('vm-a', { [SANDBOX_ID_METADATA_KEY]: 'logical-1' }, 'paused')];
    await expect(demo.vmStatus('vm-a', 'logical-1')).resolves.toBe('paused');
    await expect(demo.vmStatus('vm-b', 'logical-1')).resolves.toBe('absent');
    expect(sdk.list).toHaveBeenCalledWith({ metadata: { [SANDBOX_ID_METADATA_KEY]: 'logical-1' } });
  });
});

describe('mintViewerUrl', () => {
  it('returns null without resuming a VM that is not running', async () => {
    const { sandbox } = createDesktopWorkspace();
    await expect(demo.mintViewerUrl(sandbox)).resolves.toBeNull();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('publishes the viewer port as private and asks for a view-only URL', async () => {
    const { sandbox } = createDesktopWorkspace();
    await sandbox.start();
    const url = await demo.mintViewerUrl(sandbox);
    expect(url).toMatch(/^https:\/\//);
    expect(vm.publishPreviewPort).toHaveBeenCalledWith(6080, { access: 'private' });
    expect(vm.desktop.getStreamUrl).toHaveBeenCalledWith({ viewOnly: true });
  });
});

describe('startViewerRedirect', () => {
  function get(port: number, path = '/', host = `localhost:${port}`) {
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('redirects / to a freshly minted URL on each request and marks the viewer opened', async () => {
    let n = 0;
    const viewer = await demo.startViewerRedirect(async () => `https://viewer.invalid/vnc.html?token=secret-${++n}`, 0);
    const port = Number(new URL(viewer.localUrl).port);
    try {
      expect(viewer.localUrl).toBe(`http://localhost:${port}/`);
      const first = await get(port);
      expect(first.status).toBe(302);
      expect(first.location).toBe('https://viewer.invalid/vnc.html?token=secret-1');
      await viewer.opened;
      expect((await get(port, '/', `127.0.0.1:${port}`)).location).toContain('secret-2');
    } finally {
      await viewer.close();
    }
  });

  it('refuses foreign Host headers, other paths, and unavailable or non-https URLs', async () => {
    let next: string | null = null;
    const viewer = await demo.startViewerRedirect(async () => next, 0);
    const port = Number(new URL(viewer.localUrl).port);
    try {
      expect((await get(port, '/', 'evil.example:80')).status).toBe(403);
      expect((await get(port, '/favicon.ico')).status).toBe(404);
      const paused = await get(port);
      expect(paused.status).toBe(503);
      expect(paused.location).toBeUndefined();
      next = 'http://plain.invalid/?token=x';
      expect((await get(port)).status).toBe(503);
    } finally {
      await viewer.close();
    }
  });
});

describe('waitForViewer (regression: exit 13 while waiting for the viewer)', () => {
  /** Record the timers waitForViewer creates and the ones it clears. */
  function trackTimers() {
    const real = globalThis.setTimeout;
    const created: NodeJS.Timeout[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const h = real(fn, ms);
      created.push(h);
      return h;
    }) as typeof setTimeout);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    return { created, cleared };
  }

  it('holds the event loop with a ref\'d timer, resolves true when opened, and clears the timer', async () => {
    const { created, cleared } = trackTimers();
    let open!: () => void;
    const wait = demo.waitForViewer({ opened: new Promise<void>((r) => (open = r)) }, 60_000);
    expect(created).toHaveLength(1);
    expect(created[0]!.hasRef()).toBe(true);
    open();
    await expect(wait).resolves.toBe(true);
    expect(cleared).toHaveBeenCalledWith(created[0]);
  });

  it('resolves false after the timeout and clears the timer', async () => {
    const { created, cleared } = trackTimers();
    await expect(demo.waitForViewer({ opened: new Promise(() => {}) }, 20)).resolves.toBe(false);
    expect(created).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(created[0]);
  });

  it('closes the redirect server once the wait is over', async () => {
    const viewer = await demo.startViewerRedirect(async () => 'https://viewer.invalid/', 0);
    const port = Number(new URL(viewer.localUrl).port);
    await expect(demo.waitForViewer(viewer, 10)).resolves.toBe(false);
    await viewer.close();
    await expect(
      new Promise((resolve, reject) => request({ host: '127.0.0.1', port }, resolve).on('error', reject).end()),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('viewer wait in a real Node process (top-level await, as in examples/agent.ts)', () => {
  const fixture = fileURLToPath(new URL('./fixtures/viewer-wait.ts', import.meta.url));

  /** Run the fixture; `onUrl` may open the viewer once the URL is printed. */
  function run(mode: 'fixed' | 'unref', waitMs: number, onUrl?: (url: string) => void) {
    return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode, String(waitMs)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c;
        const url = /url: (\S+)/.exec(out)?.[1];
        if (url && onUrl) {
          onUrl(url);
          onUrl = undefined;
        }
      });
      child.stderr.on('data', (c: Buffer) => (out += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out }));
    });
  }
  const openViewer = (url: string) => {
    const { port } = new URL(url);
    setTimeout(() => request({ host: '127.0.0.1', port, headers: { host: `localhost:${port}` } }).end(), 300);
  };

  it('stays alive until the viewer is opened, then continues and cleans up', async () => {
    const { code, out } = await run('fixed', 30_000, openViewer);
    expect(out).toContain('opened');
    expect(out).toContain('cleanup: finally');
    expect(out).not.toContain('cleanup: beforeExit');
    expect(code).toBe(0);
  }, 30_000);

  it('stays alive for the whole timeout, then fails gracefully and cleans up', async () => {
    const started = Date.now();
    const { code, out } = await run('fixed', 1_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(out).toContain('FAIL: viewer not opened');
    expect(out).toContain('cleanup: finally');
    expect(out).not.toContain('cleanup: beforeExit');
    expect(code).toBe(1);
  }, 30_000);

  // Without the safety net Node exits with 13 ("unsettled top-level await"); the net's
  // process.exitCode = 1 takes precedence, so it exits 1 after cleaning up.
  it('old unref\'d wait: the loop drains and only the beforeExit safety net cleans up', async () => {
    const { code, out } = await run('unref', 30_000);
    expect(out).toContain('cleanup: beforeExit');
    expect(out).not.toContain('cleanup: finally');
    expect(out).not.toContain('opened');
    expect(code).toBe(1);
  }, 30_000);
});
