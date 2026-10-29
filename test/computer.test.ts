import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SandboxError,
  SandboxUnsupportedFeatureError,
  Workspace,
  supportsComputer,
  type SandboxComputer,
  type WorkspaceSandbox,
} from '@mastra/core/workspace';
import { TimeoutError } from '@superserve/sdk';
import { fakePng, fakeVm, type FakeVm } from './fakes.js';

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

const { SuperserveSandbox } = await import('../src/index.js');

let vm: FakeVm;
let sandbox: InstanceType<typeof SuperserveSandbox>;
let computer: SandboxComputer;

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-desk');
  sdk.create.mockResolvedValue(vm);
  sdk.list.mockResolvedValue([]);
  sandbox = new SuperserveSandbox();
  computer = sandbox.computer;
});

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

const REQUIRED_METHODS = [
  'screenshot',
  'leftClick',
  'rightClick',
  'doubleClick',
  'moveMouse',
  'drag',
  'scroll',
  'type',
  'press',
  'getScreenSize',
  'getCursorPosition',
] as const;

describe('SandboxComputer contract', () => {
  it('supportsComputer() recognizes the sandbox without starting it', () => {
    expect(supportsComputer(sandbox)).toBe(true);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('exposes every required method plus streamUrl as functions', () => {
    for (const m of REQUIRED_METHODS) expect(typeof computer[m], m).toBe('function');
    expect(typeof computer.streamUrl).toBe('function');
  });

  it('supportsComputer() is false when any required method is missing (sanity check of the guard)', () => {
    for (const missing of REQUIRED_METHODS) {
      const partial = { ...computer, [missing]: undefined };
      expect(supportsComputer({ computer: partial } as unknown as WorkspaceSandbox), missing).toBe(false);
    }
  });

  it('a Workspace built on this sandbox registers the computer tools', async () => {
    const workspace = new Workspace({ sandbox });
    const { createWorkspaceTools } = await import('@mastra/core/workspace');
    const tools = await createWorkspaceTools(workspace);
    const names = Object.keys(tools);
    expect(names.filter((n) => n.includes('computer')).length).toBeGreaterThanOrEqual(REQUIRED_METHODS.length - 2);
    expect(names).toEqual(expect.arrayContaining(['mastra_workspace_computer_screenshot']));
    expect(sdk.create).not.toHaveBeenCalled(); // tool registration is not I/O
  });
});

describe('screenshot & screen size', () => {
  it('returns PNG bytes with image/png and starts the VM lazily', async () => {
    const shot = await computer.screenshot();
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(vm.desktop.screenshot).toHaveBeenCalledWith();
    expect(shot.mediaType).toBe('image/png');
    expect(Array.from(shot.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects a non-PNG frame instead of mislabelling it', async () => {
    vm.desktop.screenshot.mockResolvedValueOnce({ data: new Uint8Array([0xff, 0xd8, 0xff]), width: 1, height: 1, format: 'jpeg' } as never);
    const err = await rejection(computer.screenshot());
    expect(err.code).toBe('UNEXPECTED_SCREENSHOT');
  });

  it('getScreenSize reads the dimensions from a fresh screenshot', async () => {
    vm.desktop.screenshot.mockResolvedValueOnce({ data: fakePng(1920, 1080), width: 1920, height: 1080, format: 'png' });
    await expect(computer.getScreenSize()).resolves.toEqual({ width: 1920, height: 1080 });
  });
});

describe('pointer mappings', () => {
  it('leftClick / rightClick / doubleClick / moveMouse call the matching SDK method', async () => {
    await computer.leftClick(10, 20);
    await computer.rightClick(11, 21);
    await computer.doubleClick(12, 22);
    await computer.moveMouse(0, 0);
    expect(vm.desktop.click).toHaveBeenCalledWith(10, 20);
    expect(vm.desktop.rightClick).toHaveBeenCalledWith(11, 21);
    expect(vm.desktop.doubleClick).toHaveBeenCalledWith(12, 22);
    expect(vm.desktop.moveMouse).toHaveBeenCalledWith(0, 0);
  });

  it('drag maps {x,y} positions to the SDK tuple form', async () => {
    await computer.drag({ x: 100, y: 200 }, { x: 300, y: 400 });
    expect(vm.desktop.drag).toHaveBeenCalledWith([100, 200], [300, 400]);
  });

  it.each([
    [-1, 5],
    [5, -1],
    [1.5, 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
  ])('rejects invalid coordinates (%s, %s) before any SDK call', async (x, y) => {
    const err = await rejection(computer.leftClick(x, y));
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(sdk.create).not.toHaveBeenCalled();
    expect(vm.desktop.click).not.toHaveBeenCalled();
  });

  it('rejects invalid drag endpoints', async () => {
    await expect(computer.drag({ x: 1, y: 1 }, { x: -3, y: 1 })).rejects.toThrow(/drag end/);
    expect(vm.desktop.drag).not.toHaveBeenCalled();
  });

  it('rejects coordinates outside the known display after re-checking the size once', async () => {
    await computer.screenshot(); // learn 1280x800
    const err = await rejection(computer.leftClick(1280, 10));
    expect(err.code).toBe('COORDINATE_OUT_OF_BOUNDS');
    expect(vm.desktop.screenshot).toHaveBeenCalledTimes(2); // one re-check
    expect(vm.desktop.click).not.toHaveBeenCalled();
  });

  it('accepts coordinates after the display grew', async () => {
    await computer.screenshot(); // 1280x800
    vm.desktop.screenshot.mockResolvedValueOnce({ data: fakePng(1920, 1080), width: 1920, height: 1080, format: 'png' });
    await computer.leftClick(1500, 900);
    expect(vm.desktop.click).toHaveBeenCalledWith(1500, 900);
  });

  it('maps a desktop timeout honestly (input may have landed)', async () => {
    vm.desktop.click.mockRejectedValueOnce(new TimeoutError('Request timed out after 30000ms'));
    const err = await rejection(computer.leftClick(5, 5));
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(err.message).toMatch(/may still have been delivered/);
  });
});

describe('scroll', () => {
  it('maps down to positive dy and up to negative dy', async () => {
    await computer.scroll('down', 3);
    await computer.scroll('up', 2);
    expect(vm.desktop.scroll.mock.calls).toEqual([[{ dy: 3 }], [{ dy: -2 }]]);
  });

  it.each([
    ['left', 1],
    ['down', 0],
    ['down', -1],
    ['up', 1.5],
  ])('rejects scroll(%s, %s)', async (direction, amount) => {
    await expect(computer.scroll(direction as 'up', amount)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(vm.desktop.scroll).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('type sends literal text', async () => {
    await computer.type('echo "$HOME" && ls');
    expect(vm.desktop.write).toHaveBeenCalledWith('echo "$HOME" && ls');
  });

  it.each([
    ['Enter', ['Return']],
    ['Escape', ['Escape']],
    ['ArrowUp', ['Up']],
    ['PageDown', ['Page_Down']],
    ['f5', ['F5']],
    ['ctrl+shift+t', ['ctrl', 'shift', 't']],
    [['ctrl', 's'], ['ctrl', 's']],
    [['Control', 'C'], ['ctrl', 'c']],
    [['cmd', 'Tab'], ['super', 'Tab']],
    ['ctrl++', ['ctrl', 'plus']],
    ['/', ['slash']],
  ])('press(%j) sends %j', async (input, expected) => {
    await computer.press(input as string | string[]);
    expect(vm.desktop.press).toHaveBeenCalledWith(expected);
  });

  it('rejects a non-modifier in modifier position', async () => {
    await expect(computer.press(['a', 'b'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(vm.desktop.press).not.toHaveBeenCalled();
  });
});

describe('getCursorPosition (real xdotool query)', () => {
  it('runs xdotool on the configured display and parses its output', async () => {
    vm.commands.run.mockResolvedValueOnce({ stdout: 'X=618\nY=411\nSCREEN=0\nWINDOW=29360131\n', stderr: '', exitCode: 0, truncated: false });
    await expect(computer.getCursorPosition()).resolves.toEqual({ x: 618, y: 411 });
    expect(vm.commands.run).toHaveBeenCalledWith('xdotool getmouselocation --shell', {
      env: { DISPLAY: ':1' },
      timeoutMs: 10_000,
    });
  });

  it('honours a custom display without interpolating it into the command', async () => {
    const s = new SuperserveSandbox({ display: ':2' });
    vm.commands.run.mockResolvedValueOnce({ stdout: 'X=1\nY=2\n', stderr: '', exitCode: 0, truncated: false });
    await s.computer.getCursorPosition();
    expect(vm.commands.run).toHaveBeenCalledWith('xdotool getmouselocation --shell', expect.objectContaining({ env: { DISPLAY: ':2' } }));
  });

  it('reports a missing xdotool as unsupported, not a fake position', async () => {
    vm.commands.run.mockResolvedValueOnce({ stdout: '', stderr: 'sh: xdotool: not found', exitCode: 127, truncated: false });
    await expect(computer.getCursorPosition()).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  it.each([
    [{ stdout: '', stderr: "Can't open display: :1", exitCode: 1 }],
    [{ stdout: 'garbage', stderr: '', exitCode: 0 }],
    [{ stdout: 'X=-1\nY=5', stderr: '', exitCode: 0 }],
  ])('fails loudly on unusable output %j', async (r) => {
    vm.commands.run.mockResolvedValueOnce({ ...r, truncated: false });
    await expect(computer.getCursorPosition()).rejects.toMatchObject({ code: 'CURSOR_QUERY_FAILED' });
  });
});

describe('streamUrl', () => {
  it('publishes the noVNC port with private access, then returns the SDK URL', async () => {
    const url = await computer.streamUrl!();
    expect(vm.publishPreviewPort).toHaveBeenCalledWith(6080, { access: 'private' });
    expect(vm.desktop.getStreamUrl).toHaveBeenCalled();
    expect(vm.publishPreviewPort.mock.invocationCallOrder[0]!).toBeLessThan(vm.desktop.getStreamUrl.mock.invocationCallOrder[0]!);
    expect(url).toMatch(/vnc\.html/);
  });

  it('returns null without starting a VM when the live view is disabled', async () => {
    const s = new SuperserveSandbox({ liveView: false });
    await expect(s.computer.streamUrl!()).resolves.toBeNull();
    expect(sdk.create).not.toHaveBeenCalled();
    await s._start();
    expect(sdk.create.mock.calls[0]![0]).not.toHaveProperty('previewAccess');
  });

  it('propagates publish failures instead of returning a dead URL', async () => {
    vm.publishPreviewPort.mockRejectedValueOnce(new Error('preview publishing unavailable'));
    await expect(computer.streamUrl!()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(vm.desktop.getStreamUrl).not.toHaveBeenCalled();
  });
});
