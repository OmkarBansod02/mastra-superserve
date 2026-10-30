// writeFiles end to end against a real POSIX shell: the fake VM's
// commands.spawn runs the generated script under the local /bin/sh as the
// current (non-root) user, piping stdin like Superserve's exec socket does.
// This is the Phase 4A regression: files must belong to the command user and
// stay editable by it, byte-exact, with no partial writes.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '@mastra/core/workspace';
import { fakeVm, type FakeVm } from './fakes.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), connect: vi.fn(), list: vi.fn(), killById: vi.fn() }));
vi.mock('@superserve/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@superserve/sdk')>();
  return { ...actual, Sandbox: sdk };
});
const { SuperserveSandbox } = await import('../src/index.js');

const isRoot = process.getuid?.() === 0;
const uid = process.getuid!();

/**
 * A `commands.spawn` backed by a local `sh -c`. `mangle` tampers with the
 * stdin bytes in transit (to simulate frames the SDK dropped).
 */
function localSpawn(mangle?: (bytes: Buffer) => Buffer) {
  return vi.fn(async (command: string) => {
    const child = spawn('/bin/sh', ['-c', `umask 022\n${command}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {}); // EPIPE when the script exits early
    const done = new Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ stdout, stderr, exitCode: code ?? (signal ? 128 : 1), truncated: false }));
    });
    const pending: Buffer[] = [];
    return {
      stdin: {
        write: (data: string | Uint8Array) => void pending.push(Buffer.from(data)),
        close: () => {
          const all = Buffer.concat(pending);
          child.stdin.end(mangle ? mangle(all) : all);
        },
      },
      kill: () => void child.kill(),
      wait: () => done,
      close: async () => {
        child.kill();
        await done.catch(() => {});
      },
    };
  });
}

let root: string;
let vm: FakeVm;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mastra-ss-write-'));
  vm = fakeVm('vm-local');
  vm.commands.spawn = localSpawn() as unknown as FakeVm['commands']['spawn'];
  for (const fn of Object.values(sdk)) fn.mockReset();
  sdk.create.mockResolvedValue(vm);
});
afterEach(() => {
  // Undo any chmod a test applied so cleanup can remove everything.
  for (const p of [root, join(root, 'locked')]) if (existsSync(p)) chmodSync(p, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('.mastra-write-'));
const mode = (p: string) => statSync(p).mode & 0o777;

describe('writeFiles through a real shell', () => {
  it('preserves binary content byte for byte', async () => {
    const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    // > 32 KiB so the SDK's stdin chunking would split it across frames.
    const big = randomBytes(300_000);
    const text = 'line1\r\nnul\0 tab\t emoji 🚀 trailing\n\n';
    await new SuperserveSandbox().writeFiles([
      { path: join(root, 'every.bin'), content: every },
      { path: join(root, 'big.bin'), content: big },
      { path: join(root, 'text.txt'), content: text },
      { path: join(root, 'empty'), content: '' },
    ]);
    expect(readFileSync(join(root, 'every.bin')).equals(every)).toBe(true);
    expect(readFileSync(join(root, 'big.bin')).equals(big)).toBe(true);
    expect(readFileSync(join(root, 'text.txt'), 'utf8')).toBe(text);
    expect(readFileSync(join(root, 'empty')).length).toBe(0);
    expect(leftovers(root)).toEqual([]);
  });

  it('creates files and missing parent dirs owned by the command user, which can then edit, rename and delete them', async () => {
    const file = join(root, 'a', 'b', 'c.txt');
    await new SuperserveSandbox().writeFiles([{ path: file, content: 'hi' }]);

    for (const p of [file, join(root, 'a', 'b'), join(root, 'a')]) expect(statSync(p).uid).toBe(uid);
    expect(mode(file)).toBe(0o644);
    expect(mode(join(root, 'a', 'b'))).toBe(0o755);

    // The exact operations that failed in the Phase 4A probe (O2–O6), as the same user.
    const dir = join(root, 'a', 'b');
    const out = execFileSync(
      '/bin/sh',
      ['-c', 'echo more >> "$1" && sed -i s/hi/HI/ "$1" && mv "$1" "$2/d.txt" && touch "$2/sibling" && rm "$2/d.txt" && echo OK', 'sh', file, dir],
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('OK');
    expect(readdirSync(dir)).toEqual(['sibling']);
  });

  it('overwrites atomically, keeps the existing mode, and replaces a file the user cannot write in place', async () => {
    const file = join(root, 'existing');
    writeFileSync(file, 'old');
    chmodSync(file, 0o400); // read-only: `cat > file` would fail, rename does not
    await new SuperserveSandbox().writeFiles([{ path: file, content: 'new' }]);
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(mode(file)).toBe(0o400);
    expect(statSync(file).uid).toBe(uid);
    expect(leftovers(root)).toEqual([]);
  });

  it('writes through a symlink to its target and keeps the link', async () => {
    const target = join(root, 'real.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'old');
    symlinkSync(target, link);
    await new SuperserveSandbox().writeFiles([{ path: link, content: 'via link' }]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('via link');
  });

  it('resolves relative and chained symlinks before the rename, so no link entry is replaced', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'real.txt'), 'old');
    symlinkSync('sub/real.txt', join(root, 'hop'));
    symlinkSync('hop', join(root, 'link'));
    symlinkSync('missing.txt', join(root, 'dangling'));
    await new SuperserveSandbox().writeFiles([
      { path: join(root, 'link'), content: 'chained' },
      { path: join(root, 'dangling'), content: 'created' },
    ]);
    expect(readlinkSync(join(root, 'link'))).toBe('hop');
    expect(readlinkSync(join(root, 'hop'))).toBe('sub/real.txt');
    expect(readFileSync(join(root, 'sub', 'real.txt'), 'utf8')).toBe('chained');
    expect(readlinkSync(join(root, 'dangling'))).toBe('missing.txt');
    expect(readFileSync(join(root, 'missing.txt'), 'utf8')).toBe('created');
    expect([...leftovers(root), ...leftovers(join(root, 'sub'))]).toEqual([]);
  });

  it('names the link when it cannot be resolved, and refuses a link to a directory', async () => {
    symlinkSync('nodir/x', join(root, 'broken'));
    mkdirSync(join(root, 'd'));
    symlinkSync('d', join(root, 'dirlink'));
    const sandbox = new SuperserveSandbox();
    const broken = await sandbox.writeFiles([{ path: join(root, 'broken'), content: 'x' }]).catch((e) => e);
    expect(broken.code).toBe('WRITE_FAILED');
    expect(broken.message).toContain(`cannot resolve symlink ${join(root, 'broken')}`);
    const dirlink = await sandbox.writeFiles([{ path: join(root, 'dirlink'), content: 'x' }]).catch((e) => e);
    expect(dirlink.message).toMatch(/is a directory/);
    expect(lstatSync(join(root, 'dirlink')).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(root, 'd'))).toEqual([]);
  });

  it('refuses to write over a directory instead of moving the file into it', async () => {
    const dir = join(root, 'adir');
    mkdirSync(dir);
    const err = await new SuperserveSandbox().writeFiles([{ path: dir, content: 'x' }]).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(err.code).toBe('WRITE_FAILED');
    expect(err.message).toMatch(/is a directory/);
    expect(readdirSync(dir)).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });

  it('rejects content that arrived incomplete and leaves the destination untouched', async () => {
    vm.commands.spawn = localSpawn((b) => b.subarray(0, b.length - 1)) as unknown as FakeVm['commands']['spawn'];
    const file = join(root, 'keep.txt');
    writeFileSync(file, 'original');
    const err = await new SuperserveSandbox().writeFiles([{ path: file, content: 'replacement' }]).catch((e) => e);
    expect(err.code).toBe('WRITE_FAILED');
    expect(err.message).toMatch(/sha256 mismatch/);
    expect(readFileSync(file, 'utf8')).toBe('original');
    expect(leftovers(root)).toEqual([]);
  });

  it('rejects a single flipped byte (not just short writes)', async () => {
    vm.commands.spawn = localSpawn((b) => {
      const c = Buffer.from(b);
      c[0] = c[0]! ^ 0xff;
      return c;
    }) as unknown as FakeVm['commands']['spawn'];
    const err = await new SuperserveSandbox().writeFiles([{ path: join(root, 'f'), content: 'abc' }]).catch((e) => e);
    expect(err.message).toMatch(/sha256 mismatch/);
    expect(existsSync(join(root, 'f'))).toBe(false);
  });

  it('handles hostile file names literally (no shell injection)', async () => {
    const name = "it's $(touch PWNED) `touch PWNED2`; \"q\" \\ *\nnewline";
    await new SuperserveSandbox().writeFiles([{ path: join(root, name), content: 'safe' }]);
    expect(readFileSync(join(root, name), 'utf8')).toBe('safe');
    expect(readdirSync(root).sort()).toEqual([name]);
    expect(existsSync(join(process.cwd(), 'PWNED'))).toBe(false);
  });

  it.skipIf(isRoot)('fails with the kernel’s permission error when the user cannot write there (no sudo fallback)', async () => {
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    const err = await new SuperserveSandbox().writeFiles([{ path: join(locked, 'x'), content: 'x' }]).catch((e) => e);
    expect(err.code).toBe('WRITE_FAILED');
    expect(err.message).toMatch(/Permission denied/);
    chmodSync(locked, 0o755);
    expect(readdirSync(locked)).toEqual([]);
  });
});
