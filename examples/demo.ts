/**
 * Recording helpers for `DEMO_MODE=1 pnpm example:agent`:
 *
 * - `createToolCallLogger`: one concise `[AGENT]` line per real Mastra tool
 *   call, printed as the call happens (from `onChunk`). Only allowlisted,
 *   non-sensitive arguments are shown (coordinates, key names, scroll
 *   direction); typed text, shell commands and every tool result (including
 *   screenshot bytes) are never printed.
 * - `showcasePersistence`: a deterministic, script-driven lifecycle check after
 *   the agent finishes: pause the VM, attach a new provider instance to it by
 *   `sandboxId`, check the saved file and a usable desktop, then hand the new
 *   instance to the caller's cleanup. The LLM does not choose these steps.
 * - `startViewerRedirect`: a localhost-only endpoint that mints a fresh
 *   private, view-only viewer URL on each request and 302-redirects the
 *   browser to it. The credential-bearing URL is never printed, logged, or
 *   passed on a command line.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Workspace, WorkspaceToolsConfig } from '@mastra/core/workspace';
import { DESKTOP_STREAM_PORT, Sandbox as SdkSandbox } from '@superserve/sdk';
import { SANDBOX_ID_METADATA_KEY, SuperserveSandbox, type SuperserveSandboxOptions } from '../src/index.js';
import { createDesktopWorkspace } from './desktop-agent.js';

export type Log = (line: string) => void;

const TOOL_PREFIX = 'mastra_workspace_';
const SAFE_KEY = /^[A-Za-z0-9_+\- ]{1,32}$/;

/** `mastra_workspace_computer_click` → `computer_click`. */
export function toolLabel(toolName: string | undefined): string {
  const name = String(toolName ?? 'unknown');
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '?');
const key = (v: unknown) => (typeof v === 'string' && SAFE_KEY.test(v) ? v : '?');

/**
 * One log line for a tool call. Arguments are allowlisted per tool; anything
 * not listed here (typed text, commands, unknown tools' args) is left out.
 */
export function formatToolCall(toolName: string | undefined, args: unknown): string {
  const label = toolLabel(toolName);
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  let detail = '';
  switch (label) {
    case 'computer_click':
    case 'computer_double_click':
    case 'computer_right_click':
    case 'computer_move_mouse':
      detail = `(${num(a.x)}, ${num(a.y)})`;
      break;
    case 'computer_drag':
      detail = `(${num(a.startX)}, ${num(a.startY)}) -> (${num(a.endX)}, ${num(a.endY)})`;
      break;
    case 'computer_press_key':
      detail = Array.isArray(a.key) ? a.key.map(key).join('+') : key(a.key);
      break;
    case 'computer_scroll':
      detail = `${a.direction === 'up' || a.direction === 'down' ? a.direction : '?'}${a.amount === undefined ? '' : ` ${num(a.amount)}`}`;
      break;
    case 'computer_wait':
      detail = `${num(a.seconds)}s`;
      break;
    case 'computer_type':
      detail = `(${typeof a.text === 'string' ? a.text.length : '?'} chars)`;
      break;
  }
  return `[AGENT] ${label}${detail ? ` ${detail}` : ''}`;
}

type ToolPayload = { toolName?: string; args?: unknown; isError?: boolean; result?: { error?: unknown } };

/**
 * An `onChunk` handler that logs tool calls as they start and flags failed
 * ones: a thrown tool error arrives as `tool-error`, rejected input as a
 * `tool-result` whose result has `error: true`. Error details are not printed.
 */
export function createToolCallLogger(log: Log) {
  return (chunk: { type?: string; payload?: unknown }) => {
    const p = chunk.payload as ToolPayload | undefined;
    const failedResult = chunk.type === 'tool-result' && (p?.isError === true || p?.result?.error === true);
    if (chunk.type === 'tool-call') log(formatToolCall(p?.toolName, p?.args));
    else if (failedResult || chunk.type === 'tool-error') log(`[AGENT] ${toolLabel(p?.toolName)} failed`);
  };
}

/** First 8 characters of a VM UUID, enough to show two ids match. */
export function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : '(none)';
}

/**
 * The VM's status according to the Superserve control plane, without
 * resuming it. Deleted VMs are not listed, so they read as `'absent'`.
 */
export async function vmStatus(sandboxId: string, logicalId: string): Promise<string> {
  const rows = await SdkSandbox.list({ metadata: { [SANDBOX_ID_METADATA_KEY]: logicalId } });
  return rows.find((r) => r.id === sandboxId)?.status ?? 'absent';
}

/** Poll `vmStatus` until it is one of `want`; returns the last status seen. */
export async function waitForVmStatus(
  sandboxId: string,
  logicalId: string,
  want: string[],
  { attempts = 15, intervalMs = 1000 } = {},
): Promise<string> {
  let status = await vmStatus(sandboxId, logicalId);
  for (let i = 1; i < attempts && !want.includes(status); i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    status = await vmStatus(sandboxId, logicalId);
  }
  return status;
}

export interface PersistenceShowcaseOptions {
  /** The sandbox and workspace the agent used. */
  sandbox: SuperserveSandbox;
  workspace: Workspace;
  /** File the agent saved and text it must contain (the verification token). */
  target: string;
  expected: string;
  /** Options for the new provider instance (`id` and `sandboxId` are set here). */
  sandboxOptions?: SuperserveSandboxOptions;
  /** Tool config for the new instance's workspace (tests shorten screenshot delays). */
  tools?: WorkspaceToolsConfig;
  /**
   * Called as soon as the new instance exists, before it attaches, so the
   * caller's cleanup can destroy it whatever happens next.
   */
  onRestored: (restored: { sandbox: SuperserveSandbox; workspace: Workspace }) => void;
  /** Called with the reattached desktop's screenshot (PNG bytes). */
  onScreenshot?: (png: Uint8Array) => void;
  log: Log;
  /** Status polling (tests shorten it). */
  poll?: { attempts?: number; intervalMs?: number };
}

/**
 * Pause → new provider instance → reattach by `sandboxId` → verify. Returns
 * whether every step passed; stops at the first failure with a `[VM] FAILED`
 * line. Does not destroy anything: the caller's cleanup does that.
 */
export async function showcasePersistence(o: PersistenceShowcaseOptions): Promise<boolean> {
  const { sandbox, workspace, target, expected, log } = o;
  const fail = (step: string, detail: string) => {
    log(`[VM] FAILED: ${step} (${detail})`);
    return false;
  };
  const savedId = sandbox.sandboxId;
  const logicalId = sandbox.id;
  if (!savedId) return fail('no VM to pause', 'sandbox has no sandboxId');

  const before = await sandbox.executeCommand('cat', [target]);
  if (before.exitCode !== 0 || !before.stdout.includes(expected)) {
    return fail('file check before pause', `exit ${before.exitCode}`);
  }
  log(`[VM] File verified: ${target}`);

  await workspace.stop();
  const paused = await waitForVmStatus(savedId, logicalId, ['paused'], o.poll);
  if (sandbox.status !== 'stopped' || paused !== 'paused') {
    return fail('pause', `provider ${sandbox.status}, VM ${paused}`);
  }
  log(`[VM] Paused (Superserve reports: ${paused})`);

  // Only what an app would persist: the VM id and the logical id that owns it.
  const restored = createDesktopWorkspace({ ...o.sandboxOptions, id: logicalId, sandboxId: savedId }, o.tools);
  o.onRestored(restored);
  log(`[VM] New provider instance created from saved sandboxId ${shortId(savedId)}`);

  await restored.sandbox.start();
  if (restored.sandbox.sandboxId !== savedId || restored.sandbox.ownership !== 'adopted') {
    return fail('reattach', `got ${shortId(restored.sandbox.sandboxId)}, ownership ${restored.sandbox.ownership}`);
  }
  log(`[VM] Reconnected to same sandbox ${shortId(savedId)} (ownership: ${restored.sandbox.ownership})`);

  const after = await restored.sandbox.executeCommand('cat', [target]);
  if (after.exitCode !== 0 || !after.stdout.includes(expected)) {
    return fail('file check after reattach', `exit ${after.exitCode}`);
  }
  log(`[VM] State preserved: ${target} still holds the agent's token`);

  const shot = await restored.sandbox.computer.screenshot();
  const size = await restored.sandbox.computer.getScreenSize();
  const cursor = await restored.sandbox.computer.getCursorPosition();
  o.onScreenshot?.(shot.data);
  log(`[VM] Desktop responsive: ${size.width}x${size.height} screenshot, cursor at (${cursor.x}, ${cursor.y})`);
  return true;
}

/**
 * Destroy the sandboxes (newest first) and confirm with the control plane
 * that the VM is gone. Destroying an already-deleted VM is a no-op, so a
 * stale instance holding the same VM is safe to destroy too.
 */
export async function destroyAndConfirm(
  workspaces: Workspace[],
  sandboxId: string,
  logicalId: string,
  poll?: { attempts?: number; intervalMs?: number },
): Promise<string> {
  for (const ws of workspaces) await ws.destroy();
  return waitForVmStatus(sandboxId, logicalId, ['deleted', 'absent'], poll);
}

/**
 * Mint a private, view-only viewer URL for a running sandbox, or null when it
 * is not running (paused, reconnecting, destroyed). Never resumes a VM: it
 * uses the SDK handle the provider already holds.
 */
export async function mintViewerUrl(sandbox: SuperserveSandbox): Promise<string | null> {
  if (sandbox.status !== 'running') return null;
  const sdk = sandbox.superserve;
  await sdk.publishPreviewPort(DESKTOP_STREAM_PORT, { access: 'private' });
  return sdk.desktop.getStreamUrl({ viewOnly: true });
}

export interface ViewerRedirect {
  /** The URL to open: `http://localhost:<port>/`. Carries no credential. */
  localUrl: string;
  /** Resolves on the first successful redirect. */
  opened: Promise<void>;
  close(): Promise<void>;
}

/**
 * Serve `GET /` on 127.0.0.1 as a 302 to a freshly minted viewer URL. The
 * Superserve edge swaps the signed token for a cookie and strips it from the
 * address bar, so the browser ends on a token-free URL. Requests with a
 * foreign Host header (DNS rebinding) are refused.
 */
export async function startViewerRedirect(mint: () => Promise<string | null>, port = 7777): Promise<ViewerRedirect> {
  let markOpened!: () => void;
  const opened = new Promise<void>((r) => (markOpened = r));
  const server: Server = createServer((req, res) => {
    const actual = (server.address() as AddressInfo).port;
    const hostOk = req.headers.host === `localhost:${actual}` || req.headers.host === `127.0.0.1:${actual}`;
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain' };
    if (!hostOk) return void res.writeHead(403, headers).end('forbidden\n');
    if (req.method !== 'GET' || (req.url ?? '/') !== '/') return void res.writeHead(404, headers).end('not found\n');
    mint().then(
      (url) => {
        if (!url || !url.startsWith('https://')) {
          return void res.writeHead(503, headers).end('Desktop not running right now (paused or reconnecting). Reload in a few seconds.\n');
        }
        res.writeHead(302, { ...headers, Location: url }).end();
        markOpened();
      },
      () => void res.writeHead(503, headers).end('Could not open the viewer. Reload to retry.\n'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // Never the reason the process stays up: whoever waits for `opened` must
  // hold the event loop itself (see waitForViewer).
  server.unref();
  const actual = (server.address() as AddressInfo).port;
  return {
    localUrl: `http://localhost:${actual}/`,
    opened,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        // A browser's keep-alive connection must not hold up cleanup.
        server.closeAllConnections();
      }),
  };
}

/**
 * Wait for the viewer to be opened; false after `timeoutMs`. The timeout
 * timer is deliberately not unref'd: with the server unref'd and nothing else
 * pending, it is what keeps Node alive during the wait. Otherwise the event
 * loop drains, the awaiting top-level code never settles, and Node exits with
 * code 13 without running the caller's cleanup. The timer is cleared as soon
 * as the wait ends either way.
 */
export async function waitForViewer(viewer: Pick<ViewerRedirect, 'opened'>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      viewer.opened.then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
