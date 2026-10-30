import { vi } from 'vitest';

/** Minimal PNG: signature + IHDR header (enough for dimension parsing). */
export function fakePng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(8, 13);
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return buf;
}

/**
 * A stand-in for a `commands.spawn` session: records what was written to
 * stdin and settles `wait()` with `result` (or never, when `result` is null).
 */
export function fakeSession(result: { exitCode: number; stderr?: string } | null = { exitCode: 0 }) {
  const chunks: Uint8Array[] = [];
  let stdinClosed = false;
  let settle: ((r: { stdout: string; stderr: string; exitCode: number; truncated: boolean }) => void) | undefined;
  let fail: ((e: unknown) => void) | undefined;
  const done = new Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>((res, rej) => {
    settle = res;
    fail = rej;
  });
  done.catch(() => {});
  return {
    get stdinBytes() {
      return Buffer.concat(chunks);
    },
    get stdinClosed() {
      return stdinClosed;
    },
    stdin: {
      write: vi.fn((data: string | Uint8Array) => {
        chunks.push(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
      }),
      close: vi.fn(() => {
        stdinClosed = true;
        if (result) settle!({ stdout: '', stderr: result.stderr ?? '', exitCode: result.exitCode, truncated: false });
      }),
    },
    kill: vi.fn(),
    wait: vi.fn(() => done),
    close: vi.fn(async () => {
      fail!(new Error('closed'));
    }),
  };
}
export type FakeSession = ReturnType<typeof fakeSession>;

/** A stand-in for an `@superserve/sdk` Sandbox instance. */
export function fakeVm(id: string, opts: { width?: number; height?: number } = {}) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  return {
    id,
    status: 'active',
    metadata: {},
    commands: {
      run: vi.fn(async (_command: string, _opts?: Record<string, unknown>) => ({ stdout: '', stderr: '', exitCode: 0, truncated: false })),
      spawn: vi.fn(async (_command: string, _opts?: Record<string, unknown>) => fakeSession()),
    },
    files: { write: vi.fn(async (_path: string, _content: unknown, _opts?: unknown) => {}) },
    desktop: {
      screenshot: vi.fn(async () => ({ data: fakePng(width, height), width, height, format: 'png' as const })),
      click: vi.fn(async () => {}),
      rightClick: vi.fn(async () => {}),
      doubleClick: vi.fn(async () => {}),
      moveMouse: vi.fn(async () => {}),
      drag: vi.fn(async () => {}),
      scroll: vi.fn(async () => {}),
      write: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
      getStreamUrl: vi.fn(async () => `https://6080-${id}.example.invalid/vnc.html?autoconnect=1`),
    },
    pause: vi.fn(async () => {}),
    getInfo: vi.fn(async () => ({ id, status: 'active' })),
    publishPreviewPort: vi.fn(async (port: number, o?: { access?: string }) => ({ port, tokenVersion: 1, access: o?.access ?? 'public' })),
  };
}
export type FakeVm = ReturnType<typeof fakeVm>;

/** A `Sandbox.list()` row. */
export function listRow(id: string, metadata: Record<string, string> = {}, status = 'paused') {
  return { id, name: `vm-${id}`, status, metadata, vcpuCount: 2, memoryMib: 2048, createdAt: new Date(0), previewAccess: 'private' };
}
