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
