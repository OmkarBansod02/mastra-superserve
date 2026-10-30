import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SandboxAbortError,
  SandboxError,
  SandboxTimeoutError,
  SandboxUnsupportedFeatureError,
} from '@mastra/core/workspace';
import { AuthenticationError, NotFoundError, TimeoutError } from '@superserve/sdk';
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

const { SuperserveSandbox, SANDBOX_ID_METADATA_KEY } = await import('../src/index.js');

const TAG = SANDBOX_ID_METADATA_KEY;
let vm: FakeVm;

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-1');
  sdk.create.mockResolvedValue(vm);
  sdk.connect.mockImplementation(async (id: string) => (id === vm.id ? vm : fakeVm(id)));
  sdk.list.mockResolvedValue([]);
  sdk.killById.mockResolvedValue(undefined);
});

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

describe('construction & lazy creation', () => {
  it('does no I/O until first use', () => {
    const sandbox = new SuperserveSandbox();
    expect(sandbox.status).toBe('pending');
    expect(sandbox.sandboxId).toBeUndefined();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.list).not.toHaveBeenCalled();
  });

  it('creates a desktop VM with safety defaults and an ownership tag on first command', async () => {
    const sandbox = new SuperserveSandbox({ metadata: { team: 'qa' } });
    await sandbox.executeCommand('true');

    expect(sdk.create).toHaveBeenCalledTimes(1);
    const opts = sdk.create.mock.calls[0]![0];
    expect(opts).toMatchObject({
      fromTemplate: 'superserve/desktop',
      timeoutSeconds: 900,
      autoDeleteSeconds: 600,
      previewAccess: 'private',
      metadata: { team: 'qa', [TAG]: sandbox.id },
    });
    expect(opts.name).toMatch(/^mastra-superserve-[a-zA-Z0-9-]+$/);
    expect(opts).not.toHaveProperty('apiKey'); // falls back to SDK env handling
    // A generated logical id cannot match an existing VM, so no lookup happens.
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sandbox.status).toBe('running');
    expect(sandbox.sandboxId).toBe('vm-1');
    expect(sandbox.ownership).toBe('created');
  });

  // Regression (Phase 3, live): Superserve rejects names over 64 characters, and
  // prefix + generated id + timestamp exceeded that for any prefix over 7 chars.
  it.each<[{ namePrefix?: string; id?: string }]>([
    [{ namePrefix: 'mastra-phase3' }],
    [{ namePrefix: 'p'.repeat(80) }],
    [{ id: 'x'.repeat(200) }],
    [{}],
  ])('keeps generated VM names within 64 characters (%j)', async (opts) => {
    const sandbox = new SuperserveSandbox(opts);
    await sandbox._start();
    const name: string = sdk.create.mock.calls[0]![0].name;
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/-[0-9a-z]+$/); // unique timestamp suffix survives truncation
    expect(name.startsWith((opts.namePrefix ?? 'mastra').slice(0, 10))).toBe(true);
  });

  it('coalesces concurrent first operations into one VM', async () => {
    const sandbox = new SuperserveSandbox();
    await Promise.all([sandbox.executeCommand('a'), sandbox.executeCommand('b'), sandbox.computer.type('x')]);
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('reports start outcome "created"', async () => {
    const sandbox = new SuperserveSandbox();
    await expect(sandbox._start()).resolves.toEqual({ outcome: 'created' });
  });

  it('autoDeleteSeconds: null omits auto-delete; custom values pass through', async () => {
    const sandbox = new SuperserveSandbox({ autoDeleteSeconds: null, timeoutSeconds: 120, template: 'my/desktop' });
    await sandbox._start();
    const opts = sdk.create.mock.calls[0]![0];
    expect(opts).not.toHaveProperty('autoDeleteSeconds');
    expect(opts).toMatchObject({ timeoutSeconds: 120, fromTemplate: 'my/desktop' });
  });

  it.each([
    [{ autoDeleteSeconds: 0 }, /autoDeleteSeconds/],
    [{ timeoutSeconds: 0 }, /timeoutSeconds/],
    [{ timeoutSeconds: 1.5 }, /timeoutSeconds/],
    [{ display: 'localhost:1; rm -rf /' }, /display/],
    [{ metadata: { [SANDBOX_ID_METADATA_KEY]: 'x' } }, /reserved/],
    [{ sandboxId: '' }, /sandboxId/],
    [{ liveView: 'open' as never }, /liveView/],
  ])('rejects unsafe option %j', (opts, msg) => {
    expect(() => new SuperserveSandbox(opts)).toThrow(msg);
  });

  it('never exposes the API key in info or errors', async () => {
    const secret = 'unit-test-placeholder-key';
    sdk.create.mockRejectedValueOnce(new AuthenticationError('Invalid API key'));
    const sandbox = new SuperserveSandbox({ apiKey: secret });
    const err = await rejection(sandbox._start());
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe('PROVIDER_AUTH_FAILED');
    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.details)).not.toContain(secret);
    expect(JSON.stringify(await sandbox.getInfo())).not.toContain(secret);
    expect(sdk.create.mock.calls[0]![0].apiKey).toBe(secret); // passed to the SDK only
  });
});

describe('executeCommand', () => {
  it('shell-quotes args so they cannot inject shell syntax', async () => {
    const sandbox = new SuperserveSandbox();
    const result = await sandbox.executeCommand('echo', ['hello world', "it's", '$(touch /tmp/pwned)', '`id`', 'a;b', 'plain-arg']);
    const sent = vm.commands.run.mock.calls[0]![0];
    expect(sent).toBe(`echo 'hello world' 'it'\\''s' '$(touch /tmp/pwned)' '\`id\`' 'a;b' plain-arg`);
    expect(result.command).toBe(sent);
    expect(result.args).toEqual(['hello world', "it's", '$(touch /tmp/pwned)', '`id`', 'a;b', 'plain-arg']);
  });

  it('passes a command string without args through unchanged', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox.executeCommand('ls -la | head -1');
    expect(vm.commands.run.mock.calls[0]![0]).toBe('ls -la | head -1');
  });

  it('merges the env overlay, cwd and timeout', async () => {
    const sandbox = new SuperserveSandbox({ env: { A: '1', DROP: undefined }, workingDirectory: '/home/desktop' });
    sandbox.setEnv((e) => ({ ...e, B: '2' }));
    await sandbox.executeCommand('env', [], { env: { C: '3' }, timeout: 5000 });
    expect(vm.commands.run.mock.calls[0]![1]).toEqual({
      cwd: '/home/desktop',
      env: { A: '1', B: '2', C: '3' },
      timeoutMs: 5000,
    });
  });

  it('uses the default command timeout and per-call cwd', async () => {
    const sandbox = new SuperserveSandbox({ commandTimeoutMs: 1234 });
    await sandbox.executeCommand('pwd', undefined, { cwd: '/tmp' });
    expect(vm.commands.run.mock.calls[0]![1]).toEqual({ cwd: '/tmp', timeoutMs: 1234 });
  });

  it('returns non-zero exits as results, not errors', async () => {
    vm.commands.run.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 7, truncated: false });
    const sandbox = new SuperserveSandbox();
    const r = await sandbox.executeCommand('exit 7');
    expect(r).toMatchObject({ success: false, exitCode: 7, stderr: 'boom' });
    expect(r.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('flags truncated output', async () => {
    vm.commands.run.mockResolvedValueOnce({ stdout: 'x', stderr: '[truncated]', exitCode: 0, truncated: true });
    const r = await new SuperserveSandbox().executeCommand('yes');
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(true);
  });

  it('forwards streaming callbacks', async () => {
    const onStdout = vi.fn();
    await new SuperserveSandbox().executeCommand('echo hi', [], { onStdout });
    expect(vm.commands.run.mock.calls[0]![1]).toMatchObject({ onStdout });
  });

  it('maps an SDK timeout to SandboxTimeoutError', async () => {
    vm.commands.run.mockRejectedValueOnce(new TimeoutError('Request timed out after 10000ms'));
    const err = await rejection(new SuperserveSandbox().executeCommand('sleep 100', [], { timeout: 5000 }));
    expect(err).toBeInstanceOf(SandboxTimeoutError);
    expect(err.timeoutMs).toBe(5000);
    expect(err.cause).toBeInstanceOf(TimeoutError);
  });

  it('rejects an already-aborted signal without touching the VM', async () => {
    const ac = new AbortController();
    ac.abort();
    const sandbox = new SuperserveSandbox();
    await expect(sandbox.executeCommand('true', [], { abortSignal: ac.signal })).rejects.toBeInstanceOf(SandboxAbortError);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('maps an abort during the call to SandboxAbortError', async () => {
    const ac = new AbortController();
    vm.commands.run.mockImplementationOnce(async () => {
      ac.abort();
      throw new Error('Request aborted');
    });
    const err = await rejection(new SuperserveSandbox().executeCommand('sleep 5', [], { abortSignal: ac.signal }));
    expect(err).toBeInstanceOf(SandboxAbortError);
  });

  it('wraps unknown SDK failures as PROVIDER_ERROR with the cause attached', async () => {
    const boom = new Error('socket hang up');
    vm.commands.run.mockRejectedValueOnce(boom);
    const err = await rejection(new SuperserveSandbox().executeCommand('true'));
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.cause).toBe(boom);
    expect(err.details).toMatchObject({ operation: 'executeCommand', sandboxId: 'vm-1' });
  });

  it('validates its inputs', async () => {
    const sandbox = new SuperserveSandbox();
    await expect(sandbox.executeCommand('')).rejects.toThrow(/command/);
    await expect(sandbox.executeCommand('echo', [1 as unknown as string])).rejects.toThrow(/args/);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('writeFiles', () => {
  it('writes each file through the files API', async () => {
    const sandbox = new SuperserveSandbox();
    const bin = Buffer.from([1, 2, 3]);
    await sandbox.writeFiles([
      { path: '/tmp/a.txt', content: 'hello' },
      { path: '/home/desktop/b.bin', content: bin },
    ]);
    expect(vm.files.write.mock.calls).toEqual([
      ['/tmp/a.txt', 'hello', undefined],
      ['/home/desktop/b.bin', bin, undefined],
    ]);
  });

  it('rejects explicit modes instead of silently dropping them', async () => {
    const sandbox = new SuperserveSandbox();
    await expect(sandbox.writeFiles([{ path: '/tmp/x', content: 'x', mode: 0o600 }])).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(['relative/path', '/tmp/../etc/passwd'])('rejects unsafe path %s', async (path) => {
    await expect(new SuperserveSandbox().writeFiles([{ path, content: 'x' }])).rejects.toThrow(/absolute/);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('lifecycle: stop = pause, destroy = kill (owned only)', () => {
  it('stop() pauses the VM and keeps its id; the next use resumes the same VM', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox._stop();

    expect(vm.pause).toHaveBeenCalledWith(expect.objectContaining({ wait: true }));
    expect(sandbox.status).toBe('stopped');
    expect(sandbox.sandboxId).toBe('vm-1');
    expect(sdk.killById).not.toHaveBeenCalled();

    await sandbox.executeCommand('true');
    expect(sdk.connect).toHaveBeenCalledWith('vm-1', {});
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sandbox.ownership).toBe('created');
  });

  it('a direct stop() call also leaves a consistent status', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox.stop();
    expect(sandbox.status).toBe('stopped');
    await sandbox.executeCommand('true'); // resumes rather than throwing NotReady
    expect(sdk.connect).toHaveBeenCalledWith('vm-1', {});
  });

  it('destroy() kills a VM this instance created', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox._destroy();
    expect(sdk.killById).toHaveBeenCalledWith('vm-1', {});
    expect(sandbox.status).toBe('destroyed');
    expect(sandbox.sandboxId).toBeUndefined();
  });

  it('destroy() after stop() kills the paused VM without resuming it', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox._stop();
    await sandbox._destroy();
    expect(sdk.killById).toHaveBeenCalledWith('vm-1', {});
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('destroy() before any start touches nothing', async () => {
    const sandbox = new SuperserveSandbox({ id: 'logical', sandboxId: 'vm-existing' });
    await sandbox._destroy();
    await sandbox.destroy();
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.killById).not.toHaveBeenCalled();
    expect(sandbox.status).toBe('destroyed');
  });

  it("killOnDestroy: 'never' only detaches", async () => {
    const sandbox = new SuperserveSandbox({ killOnDestroy: 'never' });
    await sandbox._start();
    await sandbox._destroy();
    expect(sdk.killById).not.toHaveBeenCalled();
    expect(sandbox.sandboxId).toBeUndefined();
  });

  it('cannot be restarted after destroy', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox._destroy();
    await expect(sandbox.executeCommand('true')).rejects.toThrow();
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it('a failed pause surfaces as an error and keeps the live handle', async () => {
    vm.pause.mockRejectedValueOnce(new TimeoutError('pause timed out'));
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    const err = await rejection(sandbox._stop());
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(sandbox.status).toBe('error');
    expect(sandbox.superserve).toBe(vm);
  });
});

describe('reattach by sandboxId', () => {
  it('adopts an untagged VM as borrowed and never kills it on destroy', async () => {
    sdk.list.mockResolvedValue([listRow('vm-ext')]);
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-ext' });
    const warn = vi.spyOn((sandbox as any).logger, 'warn');

    await expect(sandbox._start()).resolves.toEqual({ outcome: 'connected' });
    expect(sdk.list).toHaveBeenCalledWith(expect.objectContaining({ status: expect.arrayContaining(['paused', 'active']) }));
    expect(sdk.connect).toHaveBeenCalledWith('vm-ext', {});
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sandbox.sandboxId).toBe('vm-ext');
    expect(sandbox.ownership).toBe('borrowed');

    await sandbox._destroy();
    expect(sdk.killById).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without killing'));
  });

  it("killOnDestroy: 'always' kills a borrowed VM", async () => {
    sdk.list.mockResolvedValue([listRow('vm-ext')]);
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-ext', killOnDestroy: 'always' });
    await sandbox._start();
    await sandbox._destroy();
    expect(sdk.killById).toHaveBeenCalledWith('vm-ext', {});
  });

  it('adopts a VM tagged with the same logical id and kills it on destroy', async () => {
    sdk.list.mockResolvedValue([listRow('vm-mine', { [TAG]: 'session-42' })]);
    const sandbox = new SuperserveSandbox({ id: 'session-42', sandboxId: 'vm-mine' });
    await sandbox._start();
    expect(sandbox.ownership).toBe('adopted');
    await sandbox._destroy();
    expect(sdk.killById).toHaveBeenCalledWith('vm-mine', {});
  });

  it('refuses a VM tagged with a different logical id, without resuming it', async () => {
    sdk.list.mockResolvedValue([listRow('vm-other', { [TAG]: 'someone-else' })]);
    const sandbox = new SuperserveSandbox({ id: 'session-42', sandboxId: 'vm-other' });
    const err = await rejection(sandbox._start());
    expect(err.code).toBe('OWNERSHIP_MISMATCH');
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sandbox.status).toBe('error');
  });

  it('without an explicit logical id, a Mastra-tagged VM is adopted', async () => {
    sdk.list.mockResolvedValue([listRow('vm-prev', { [TAG]: 'superserve-earlier-run' })]);
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-prev' });
    await sandbox._start();
    expect(sandbox.ownership).toBe('adopted');
  });

  it("refuses to replace a gone VM by default (reattach: 'required')", async () => {
    sdk.list.mockResolvedValue([]);
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-gone' });
    const err = await rejection(sandbox.executeCommand('true'));
    expect(err.code).toBe('SANDBOX_REATTACH_FAILED');
    expect(err.details).toMatchObject({ sandboxId: 'vm-gone' });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("reattach: 'best-effort' creates a fresh VM when the old one is gone", async () => {
    sdk.list.mockResolvedValue([]);
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-gone', reattach: 'best-effort' });
    await expect(sandbox._start()).resolves.toEqual({ outcome: 'created' });
    expect(sandbox.sandboxId).toBe('vm-1');
    expect(sandbox.ownership).toBe('created');
  });

  it('fails closed when the lookup itself fails (no duplicate VM)', async () => {
    sdk.list.mockRejectedValue(new AuthenticationError('bad key'));
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-x', reattach: 'best-effort' });
    const err = await rejection(sandbox._start());
    expect(err.code).toBe('PROVIDER_AUTH_FAILED');
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('reports SANDBOX_GONE when the VM disappears between lookup and connect', async () => {
    sdk.list.mockResolvedValue([listRow('vm-race')]);
    sdk.connect.mockRejectedValueOnce(new NotFoundError('sandbox not found'));
    const sandbox = new SuperserveSandbox({ sandboxId: 'vm-race' });
    const err = await rejection(sandbox._start());
    expect(err.code).toBe('SANDBOX_GONE');
    expect(sandbox.sandboxId).toBeUndefined();
  });

  it('reports SANDBOX_GONE when a paused VM was auto-deleted before resume', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    await sandbox._stop();
    sdk.connect.mockRejectedValueOnce(new NotFoundError('sandbox not found'));
    const err = await rejection(sandbox.executeCommand('true'));
    expect(err.code).toBe('SANDBOX_GONE');
    expect(err.details).toMatchObject({ sandboxId: 'vm-1' });
    expect(sandbox.sandboxId).toBeUndefined();
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });
});

describe('logical-id discovery', () => {
  it('resumes a VM tagged with an explicit logical id instead of creating one', async () => {
    sdk.list.mockResolvedValue([listRow('vm-tagged', { [TAG]: 'project-7' })]);
    const sandbox = new SuperserveSandbox({ id: 'project-7' });
    await expect(sandbox._start()).resolves.toEqual({ outcome: 'connected' });
    expect(sdk.list).toHaveBeenCalledWith(expect.objectContaining({ metadata: { [TAG]: 'project-7' } }));
    expect(sdk.connect).toHaveBeenCalledWith('vm-tagged', {});
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sandbox.ownership).toBe('adopted');
  });

  it('ignores rows whose tag does not match (server ignoring the filter)', async () => {
    sdk.list.mockResolvedValue([listRow('vm-wrong', { [TAG]: 'other' }), listRow('vm-untagged')]);
    const sandbox = new SuperserveSandbox({ id: 'project-7' });
    await expect(sandbox._start()).resolves.toEqual({ outcome: 'created' });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it('creates when nothing is tagged with the logical id', async () => {
    const sandbox = new SuperserveSandbox({ id: 'project-8' });
    await expect(sandbox._start()).resolves.toEqual({ outcome: 'created' });
    expect(sdk.create.mock.calls[0]![0].metadata[TAG]).toBe('project-8');
  });
});

describe('VM loss during an operation', () => {
  it('a 404 confirmed by the control plane becomes SANDBOX_GONE and clears the VM', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    vm.commands.run.mockRejectedValueOnce(new NotFoundError('not found'));
    vm.getInfo.mockRejectedValueOnce(new NotFoundError('sandbox not found'));
    const err = await rejection(sandbox.executeCommand('true'));
    expect(err.code).toBe('SANDBOX_GONE');
    expect(sandbox.status).toBe('error');
    expect(sandbox.sandboxId).toBeUndefined();
  });

  it('a 404 for something else (VM still alive) is not treated as VM loss', async () => {
    const sandbox = new SuperserveSandbox();
    await sandbox._start();
    vm.commands.run.mockRejectedValueOnce(new NotFoundError('no such endpoint'));
    const err = await rejection(sandbox.executeCommand('true'));
    expect(err.code).toBe('PROVIDER_NOT_FOUND');
    expect(sandbox.status).toBe('running');
    expect(sandbox.sandboxId).toBe('vm-1');
  });
});

describe('info & escape hatch', () => {
  it('getInfo exposes ids and ownership without network calls', async () => {
    const sandbox = new SuperserveSandbox({ id: 'info-test' });
    await sandbox._start();
    const callsBefore = sdk.list.mock.calls.length;
    const info = await sandbox.getInfo();
    expect(info).toMatchObject({
      id: 'info-test',
      provider: 'superserve',
      status: 'running',
      metadata: { sandboxId: 'vm-1', ownership: 'created', template: 'superserve/desktop' },
    });
    expect(sdk.list.mock.calls.length).toBe(callsBefore);
  });

  it('superserve getter throws before start', () => {
    expect(() => new SuperserveSandbox().superserve).toThrow();
  });
});
