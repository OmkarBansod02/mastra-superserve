/**
 * Superserve Sandbox Provider
 *
 * A Superserve Firecracker microVM running a Linux desktop, exposed to Mastra
 * as a workspace sandbox with shell commands, file upload, and the
 * computer-use (`computer`) capability. Modelled on `@mastra/e2b-desktop`'s
 * `E2BDesktopSandbox`, built directly on `MastraSandbox` because there is no
 * Superserve base provider to extend.
 *
 * Two identities are kept apart on purpose:
 * - `id`: the logical Mastra sandbox id. New VMs are tagged with it in their
 *   metadata (`mastra-sandbox-id`).
 * - `sandboxId`: the physical Superserve VM UUID. Persist it to reattach to
 *   the same VM later via the `sandboxId` option.
 *
 * @see https://superserve.ai
 */
import { randomUUID } from 'node:crypto';
import type {
  CommandResult,
  ComputerPosition,
  ComputerScreenSize,
  ComputerScreenshot,
  ExecuteCommandOptions,
  MastraSandboxOptions,
  ProviderStatus,
  SandboxComputer,
  SandboxFileInput,
  SandboxInfo,
  WriteFilesOptions,
} from '@mastra/core/workspace';
import {
  MastraSandbox,
  SandboxAbortError,
  SandboxError,
  SandboxNotReadyError,
  SandboxTimeoutError,
  SandboxUnsupportedFeatureError,
  assertModesUnsupported,
} from '@mastra/core/workspace';
import {
  AuthenticationError as SdkAuthenticationError,
  DESKTOP_STREAM_PORT,
  NotFoundError as SdkNotFoundError,
  RateLimitError as SdkRateLimitError,
  Sandbox as SdkSandbox,
  TimeoutError as SdkTimeoutError,
  ValidationError as SdkValidationError,
} from '@superserve/sdk';
import type { ConnectionOptions, PreviewAccessPolicy, SandboxStatus } from '@superserve/sdk';
import {
  CURSOR_QUERY_COMMAND,
  assertCoordinate,
  assertScroll,
  invalidArgument,
  normalizeKey,
  parseMouseLocation,
  pngSize,
  shellQuote,
} from './utils.js';

/** Metadata key tagging a VM with the logical Mastra sandbox id that created it. */
export const SANDBOX_ID_METADATA_KEY = 'mastra-sandbox-id';
export const DEFAULT_TEMPLATE = 'superserve/desktop';
/** Auto-pause after 15 minutes active (Phase 1 safeguard). */
export const DEFAULT_TIMEOUT_SECONDS = 900;
/** Auto-delete after 10 minutes continuously paused (Phase 1 safeguard). */
export const DEFAULT_AUTO_DELETE_SECONDS = 600;
/** X display of the `superserve/desktop` template (Phase 1). */
export const DEFAULT_DISPLAY = ':1';
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_CURSOR_QUERY_TIMEOUT_MS = 10_000;
const DEFAULT_PAUSE_TIMEOUT_MS = 120_000;

/** Every non-terminal VM status — the ones a sandbox can be reattached from. */
const ATTACHABLE_STATUSES: readonly SandboxStatus[] = [
  'starting',
  'active',
  'pausing',
  'paused',
  'resuming',
  'migrating',
];

/**
 * How this instance came to hold its VM, which decides what `destroy()` may do.
 *
 * - `created`: this instance created the VM.
 * - `adopted`: an existing VM tagged by a Mastra Superserve sandbox (with this
 *   instance's logical `id`, when one was given explicitly).
 * - `borrowed`: an existing VM without a Mastra tag (created outside Mastra).
 */
export type SandboxOwnership = 'created' | 'adopted' | 'borrowed';

/** The VM `find()` located; `connect()` attaches to it. */
interface AttachTarget {
  sandboxId: string;
  ownership: SandboxOwnership;
}

type OperationKind = 'control' | 'command' | 'files' | 'desktop';

/**
 * Superserve sandbox provider configuration.
 */
export interface SuperserveSandboxOptions extends Omit<MastraSandboxOptions, 'processes'> {
  /**
   * Logical Mastra sandbox id. When given, `start()` first looks for an
   * existing VM tagged with it (and resumes it) before creating a new one.
   * When omitted, a random id is generated and no lookup happens.
   */
  id?: string;
  /**
   * Superserve VM UUID to reattach to. The VM is looked up without resuming
   * it; a VM tagged with a different logical `id` is refused.
   */
  sandboxId?: string;
  /**
   * What `start()` does when `sandboxId` is set but that VM no longer exists.
   *
   * - `'required'` (default): throw `SANDBOX_REATTACH_FAILED`; never replace it.
   * - `'best-effort'`: fall through to logical-id lookup, then create.
   */
  reattach?: 'required' | 'best-effort';
  /**
   * What `destroy()` does with the attached VM.
   *
   * - `'owned'` (default): kill VMs that are `created` or `adopted`; only
   *   detach from `borrowed` ones, leaving them running/paused as they were.
   * - `'always'`: kill whatever VM is attached.
   * - `'never'`: only detach; rely on auto-pause / auto-delete to clean up.
   */
  killOnDestroy?: 'owned' | 'always' | 'never';
  /** Template for new VMs. @default 'superserve/desktop' */
  template?: string;
  /** Name prefix for new VMs (a timestamp suffix keeps names unique). @default 'mastra' */
  namePrefix?: string;
  /**
   * Auto-pause a new VM after this many seconds active. Safety net against
   * leaked sessions; cannot be disabled here. @default 900
   */
  timeoutSeconds?: number;
  /**
   * Auto-delete a new VM after it has been continuously paused this long.
   * `null` keeps paused VMs forever (explicit opt-out). `0` is rejected
   * because it would turn `stop()` (pause) into a delete. @default 600
   */
  autoDeleteSeconds?: number | null;
  /** Metadata for new VMs. `mastra-sandbox-id` is reserved. */
  metadata?: Record<string, string>;
  /**
   * Access policy for the live desktop viewer, or `false` to disable
   * `computer.streamUrl()`. Also the default preview access for new VMs.
   * `'public'` lets anyone with the URL control the desktop. @default 'private'
   */
  liveView?: PreviewAccessPolicy | false;
  /** X display used for the xdotool cursor query. @default ':1' */
  display?: string;
  /** Default timeout for `executeCommand`. @default 60000 */
  commandTimeoutMs?: number;
  /** Superserve API key. Falls back to the SUPERSERVE_API_KEY env var. */
  apiKey?: string;
  /** Superserve API base URL. Falls back to SUPERSERVE_BASE_URL / the key's region. */
  baseUrl?: string;
}

/**
 * Superserve desktop sandbox for Mastra workspaces.
 *
 * - Lazy: no VM exists until the first `start()` / command / computer call.
 * - `stop()` pauses the VM (memory, disk and processes are kept); the next
 *   operation resumes the same VM.
 * - `destroy()` kills the VM when this instance owns it (see `killOnDestroy`).
 * - `computer`: screenshot, mouse and keyboard control; when used in a
 *   `Workspace`, agents get the `mastra_workspace_computer_*` tools.
 *
 * @example
 * ```typescript
 * import { Workspace } from '@mastra/core/workspace';
 * import { SuperserveSandbox } from 'mastra-superserve';
 *
 * const sandbox = new SuperserveSandbox();
 * const workspace = new Workspace({ sandbox });
 * ```
 */
export class SuperserveSandbox extends MastraSandbox<AttachTarget> {
  readonly id: string;
  readonly name = 'SuperserveSandbox';
  readonly provider = 'superserve';
  status: ProviderStatus = 'pending';

  private _sandbox: SdkSandbox | null = null;
  /** The VM this instance is attached to; kept across `stop()` so it can resume. */
  private _attached?: AttachTarget;
  private _attachedAt?: Date;
  /** Last screen size seen in a screenshot; used for bounds checks. */
  private _screenSize?: ComputerScreenSize;

  private readonly _preferredSandboxId?: string;
  private readonly _discoverByLogicalId: boolean;
  private readonly _reattach: 'required' | 'best-effort';
  private readonly _killOnDestroy: 'owned' | 'always' | 'never';
  private readonly _template: string;
  private readonly _namePrefix: string;
  private readonly _timeoutSeconds: number;
  private readonly _autoDeleteSeconds: number | null;
  private readonly _metadata: Record<string, string>;
  private readonly _liveView: PreviewAccessPolicy | false;
  private readonly _display: string;
  private readonly _connection: ConnectionOptions;

  constructor(options: SuperserveSandboxOptions = {}) {
    super({ ...options, name: 'SuperserveSandbox' });

    if (options.id !== undefined && (typeof options.id !== 'string' || options.id.trim() === '')) {
      throw invalidArgument('id must be a non-empty string');
    }
    if (options.sandboxId !== undefined && (typeof options.sandboxId !== 'string' || options.sandboxId.trim() === '')) {
      throw invalidArgument('sandboxId must be a non-empty string');
    }
    if (options.reattach !== undefined && !['required', 'best-effort'].includes(options.reattach)) {
      throw invalidArgument(`reattach must be 'required' or 'best-effort'`);
    }
    if (options.killOnDestroy !== undefined && !['owned', 'always', 'never'].includes(options.killOnDestroy)) {
      throw invalidArgument(`killOnDestroy must be 'owned', 'always' or 'never'`);
    }
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw invalidArgument('timeoutSeconds must be a positive integer (auto-pause cannot be disabled)');
    }
    const autoDeleteSeconds = options.autoDeleteSeconds === undefined ? DEFAULT_AUTO_DELETE_SECONDS : options.autoDeleteSeconds;
    if (autoDeleteSeconds !== null && (!Number.isSafeInteger(autoDeleteSeconds) || autoDeleteSeconds < 1)) {
      throw invalidArgument(
        'autoDeleteSeconds must be a positive integer, or null to keep paused VMs (0 would make stop() delete the VM)',
      );
    }
    const liveView = options.liveView ?? 'private';
    if (liveView !== false && liveView !== 'private' && liveView !== 'public') {
      throw invalidArgument(`liveView must be 'private', 'public' or false`);
    }
    const display = options.display ?? DEFAULT_DISPLAY;
    if (!/^:\d+(\.\d+)?$/.test(display)) throw invalidArgument(`display must look like ":1", got "${display}"`);
    if (options.metadata && SANDBOX_ID_METADATA_KEY in options.metadata) {
      throw invalidArgument(`metadata key "${SANDBOX_ID_METADATA_KEY}" is reserved`);
    }
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1) {
      throw invalidArgument('commandTimeoutMs must be a positive integer');
    }

    this.id = options.id ?? `superserve-${randomUUID()}`;
    this._discoverByLogicalId = options.id !== undefined;
    this._preferredSandboxId = options.sandboxId;
    this._reattach = options.reattach ?? 'required';
    this._killOnDestroy = options.killOnDestroy ?? 'owned';
    this._template = options.template ?? DEFAULT_TEMPLATE;
    this._namePrefix = options.namePrefix ?? 'mastra';
    this._timeoutSeconds = timeoutSeconds;
    this._autoDeleteSeconds = autoDeleteSeconds;
    this._metadata = { ...options.metadata };
    this._liveView = liveView;
    this._display = display;
    this.defaultCommandTimeout = commandTimeoutMs;
    this._connection = {
      ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    };
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * The Superserve VM UUID this instance is attached to. Set after the first
   * start and kept across `stop()`; cleared by `destroy()` or when the VM is
   * found to be gone. Persist it and pass it back as `sandboxId` to reattach.
   */
  get sandboxId(): string | undefined {
    return this._attached?.sandboxId;
  }

  /** How the attached VM was acquired (decides what `destroy()` does). */
  get ownership(): SandboxOwnership | undefined {
    return this._attached?.ownership;
  }

  /**
   * The underlying `@superserve/sdk` Sandbox, for APIs not exposed through
   * the Mastra abstraction (`desktop.step()`, `desktop.resize()`, previews, …).
   *
   * @throws {SandboxNotReadyError} If the sandbox is not running
   */
  get superserve(): SdkSandbox {
    if (!this._sandbox) throw new SandboxNotReadyError(this.id);
    return this._sandbox;
  }

  // -------------------------------------------------------------------------
  // Acquisition (base-orchestrated: find → connect, else create)
  // -------------------------------------------------------------------------

  protected async find(): Promise<AttachTarget | undefined> {
    // Resume the VM this instance already holds (e.g. after stop()).
    if (this._attached) return this._attached;

    if (this._preferredSandboxId) {
      const preferred = await this.lookupPreferred(this._preferredSandboxId);
      if (preferred) return preferred;
      if (this._reattach === 'required') {
        throw new SandboxError(
          `Superserve sandbox ${this._preferredSandboxId} no longer exists; refusing to create a replacement because reattach is 'required'. Clear the persisted sandboxId (or set reattach: 'best-effort') to start a fresh VM.`,
          'SANDBOX_REATTACH_FAILED',
          { provider: this.provider, sandboxId: this._preferredSandboxId, logicalId: this.id },
        );
      }
      this.logger.warn(`Superserve sandbox ${this._preferredSandboxId} is gone; falling back (reattach: 'best-effort')`);
    }

    if (this._discoverByLogicalId) return this.discoverByLogicalId();
    return undefined;
  }

  protected async connect(target: AttachTarget): Promise<void> {
    let sdk: SdkSandbox;
    try {
      // POST /activate: resumes a paused VM and returns a fresh access token.
      sdk = await SdkSandbox.connect(target.sandboxId, this._connection);
    } catch (error) {
      if (error instanceof SdkNotFoundError) {
        this.forgetVm();
        throw this.goneError(target.sandboxId, error);
      }
      throw this.toMastraError(error, 'connect', 'control');
    }
    if (sdk.id !== target.sandboxId) {
      throw new SandboxError(
        `Superserve connect(${target.sandboxId}) returned sandbox ${sdk.id}; refusing to use it`,
        'PROVIDER_ERROR',
        { sandboxId: target.sandboxId, returnedId: sdk.id },
      );
    }
    this._sandbox = sdk;
    this._attached = target;
    this._attachedAt = new Date();
    this._screenSize = undefined;
    this.logger.debug(`Attached to Superserve sandbox ${sdk.id} (${target.ownership}) for ${this.id}`);
  }

  protected async create(): Promise<void> {
    let sdk: SdkSandbox;
    try {
      sdk = await SdkSandbox.create({
        ...this._connection,
        name: this.vmName(),
        fromTemplate: this._template,
        timeoutSeconds: this._timeoutSeconds,
        ...(this._autoDeleteSeconds !== null && { autoDeleteSeconds: this._autoDeleteSeconds }),
        metadata: { ...this._metadata, [SANDBOX_ID_METADATA_KEY]: this.id },
        ...(this._liveView !== false && { previewAccess: this._liveView }),
      });
    } catch (error) {
      throw this.toMastraError(error, 'create', 'control');
    }
    this._sandbox = sdk;
    this._attached = { sandboxId: sdk.id, ownership: 'created' };
    this._attachedAt = new Date();
    this._screenSize = undefined;
    this.logger.debug(`Created Superserve sandbox ${sdk.id} from ${this._template} for ${this.id}`);
  }

  /**
   * Look up a VM by UUID without resuming it. Returns null when it does not
   * exist (or is deleted/failed). Any API error propagates, so a transient
   * failure never leads to creating a duplicate VM.
   */
  private async lookupPreferred(sandboxId: string): Promise<AttachTarget | null> {
    let infos;
    try {
      // The SDK has no non-activating get-by-id, so list attachable VMs.
      infos = await SdkSandbox.list({ ...this._connection, status: ATTACHABLE_STATUSES });
    } catch (error) {
      throw this.toMastraError(error, 'list', 'control');
    }
    const info = infos.find((s) => s.id === sandboxId);
    if (!info) return null;
    const owner = info.metadata?.[SANDBOX_ID_METADATA_KEY];
    if (owner !== undefined && this._discoverByLogicalId && owner !== this.id) {
      throw new SandboxError(
        `Superserve sandbox ${sandboxId} belongs to logical sandbox "${owner}"; refusing to attach it to "${this.id}"`,
        'OWNERSHIP_MISMATCH',
        { sandboxId, owner, logicalId: this.id },
      );
    }
    return { sandboxId, ownership: owner !== undefined ? 'adopted' : 'borrowed' };
  }

  /** Find a VM tagged with this logical id, without resuming it. */
  private async discoverByLogicalId(): Promise<AttachTarget | undefined> {
    let infos;
    try {
      infos = await SdkSandbox.list({
        ...this._connection,
        metadata: { [SANDBOX_ID_METADATA_KEY]: this.id },
        status: ATTACHABLE_STATUSES,
      });
    } catch (error) {
      throw this.toMastraError(error, 'list', 'control');
    }
    // Guard against a server that ignores the filter.
    const matches = infos.filter((s) => s.metadata?.[SANDBOX_ID_METADATA_KEY] === this.id);
    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      this.logger.warn(
        `Found ${matches.length} Superserve sandboxes tagged ${this.id}; attaching to ${matches[0]!.id}. Others: ${matches
          .slice(1)
          .map((s) => s.id)
          .join(', ')}`,
      );
    }
    return { sandboxId: matches[0]!.id, ownership: 'adopted' };
  }

  // -------------------------------------------------------------------------
  // Stop / destroy
  // -------------------------------------------------------------------------

  /**
   * Pause the VM. Memory, disk and processes are preserved and the next
   * operation resumes the same VM. Auto-delete (if configured) starts
   * counting from the pause.
   */
  async stop(): Promise<void> {
    if (!this._sandbox) return;
    try {
      await this._sandbox.pause({ wait: true, timeoutMs: DEFAULT_PAUSE_TIMEOUT_MS });
    } catch (error) {
      throw this.toMastraError(error, 'pause', 'control');
    }
    this.logger.debug(`Paused Superserve sandbox ${this._sandbox.id} for ${this.id}`);
    this._sandbox = null;
    // Keep status truthful when stop() is called directly instead of via _stop().
    this.status = 'stopped';
  }

  /**
   * Kill the attached VM if this instance owns it (see `killOnDestroy`);
   * otherwise detach and leave the VM as it is. Never looks up or kills a VM
   * this instance did not attach to.
   */
  async destroy(): Promise<void> {
    const target = this._attached;
    if (!target) {
      this.status = 'destroyed';
      return;
    }
    const kill =
      this._killOnDestroy === 'always' || (this._killOnDestroy === 'owned' && target.ownership !== 'borrowed');
    if (kill) {
      try {
        // DELETE /sandboxes/:id — works on paused VMs without resuming them.
        await SdkSandbox.killById(target.sandboxId, this._connection);
      } catch (error) {
        throw this.toMastraError(error, 'kill', 'control');
      }
      this.logger.debug(`Killed Superserve sandbox ${target.sandboxId} for ${this.id}`);
    } else {
      this.logger.warn(
        `Detached from Superserve sandbox ${target.sandboxId} without killing it (ownership: ${target.ownership}, killOnDestroy: ${this._killOnDestroy})`,
      );
    }
    this.forgetVm();
    // Keep status truthful when destroy() is called directly instead of via _destroy().
    this.status = 'destroyed';
  }

  // -------------------------------------------------------------------------
  // Commands & files
  // -------------------------------------------------------------------------

  /**
   * Run a shell command and wait for it. `command` is a shell string; each
   * entry of `args` is shell-quoted and appended. A non-zero exit code is
   * returned in the result, not thrown.
   */
  async executeCommand(command: string, args?: string[], options: ExecuteCommandOptions = {}): Promise<CommandResult> {
    if (typeof command !== 'string' || command.trim() === '') throw invalidArgument('command must be a non-empty string');
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw invalidArgument('args must be an array of strings');
    }
    const signal = options.abortSignal;
    if (signal?.aborted) throw new SandboxAbortError('executeCommand', signal.reason);

    const fullCommand = args?.length ? `${command} ${args.map(shellQuote).join(' ')}` : command;
    const timeout = options.timeout ?? this.defaultCommandTimeout;
    const env = definedEnv({ ...this.getEnv(), ...options.env });
    const cwd = options.cwd ?? this.workingDirectory;
    const started = Date.now();

    const result = await this.withLive(
      'executeCommand',
      'command',
      (sb) =>
        sb.commands.run(fullCommand, {
          ...(cwd !== undefined && { cwd }),
          ...(Object.keys(env).length > 0 && { env }),
          ...(timeout !== undefined && { timeoutMs: timeout }),
          ...(options.onStdout && { onStdout: options.onStdout }),
          ...(options.onStderr && { onStderr: options.onStderr }),
          ...(signal && { signal }),
        }),
      { timeoutMs: timeout, signal },
    );

    return {
      command: fullCommand,
      ...(args?.length && { args: [...args] }),
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: Date.now() - started,
      // Superserve drops the *tail* of combined output past its cap and
      // appends a notice to stderr; it does not say which stream lost bytes.
      ...(result.truncated && { stdoutTruncated: true, stderrTruncated: true }),
    };
  }

  /**
   * Write files into the VM through the Superserve files API (parent
   * directories are created). Paths must be absolute. Per-file `mode` is not
   * supported and is rejected rather than ignored.
   */
  async writeFiles(files: SandboxFileInput[], options: WriteFilesOptions = {}): Promise<void> {
    assertModesUnsupported(files, 'Superserve');
    for (const f of files) {
      if (typeof f.path !== 'string' || !f.path.startsWith('/') || f.path.split('/').includes('..')) {
        throw invalidArgument(`writeFiles: path must be absolute without ".." segments, got "${f.path}"`);
      }
    }
    const signal = options.abortSignal;
    if (signal?.aborted) throw new SandboxAbortError('writeFiles', signal.reason);
    await this.withLive(
      'writeFiles',
      'files',
      async (sb) => {
        for (const f of files) {
          if (signal?.aborted) throw new SandboxAbortError('writeFiles', signal.reason);
          await sb.files.write(f.path, f.content, signal ? { signal } : undefined);
        }
      },
      { signal },
    );
  }

  async getInfo(): Promise<SandboxInfo> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this._attachedAt ?? new Date(),
      metadata: {
        template: this._template,
        ...(this._attached && { sandboxId: this._attached.sandboxId, ownership: this._attached.ownership }),
      },
    };
  }

  getInstructions(): string {
    return [
      `Superserve cloud VM running a Linux desktop (template ${this._template}).`,
      `Shell commands run inside the VM; GUI apps need DISPLAY=${this._display}.`,
      'Use the computer tools (screenshot, click, type, press) to interact with the desktop.',
    ].join(' ');
  }

  // -------------------------------------------------------------------------
  // Computer use
  // -------------------------------------------------------------------------

  /**
   * Computer-use capability backed by the Superserve desktop API. Operations
   * start (or resume) the VM if needed. Coordinates are pixels from the
   * top-left of the display.
   */
  readonly computer: SandboxComputer = {
    screenshot: () => this.takeScreenshot(),
    leftClick: (x, y) => this.pointer('leftClick', x, y, (d) => d.click(x, y)),
    rightClick: (x, y) => this.pointer('rightClick', x, y, (d) => d.rightClick(x, y)),
    doubleClick: (x, y) => this.pointer('doubleClick', x, y, (d) => d.doubleClick(x, y)),
    moveMouse: (x, y) => this.pointer('moveMouse', x, y, (d) => d.moveMouse(x, y)),
    drag: async (from, to) => {
      assertCoordinate(from?.x, from?.y, 'drag start');
      assertCoordinate(to?.x, to?.y, 'drag end');
      await this.assertInBounds(from.x, from.y);
      await this.assertInBounds(to.x, to.y);
      // One batched down → move → up under the VM's input lock.
      await this.withLive('drag', 'desktop', (sb) => sb.desktop.drag([from.x, from.y], [to.x, to.y]));
    },
    scroll: async (direction, amount) => {
      assertScroll(direction, amount);
      // Superserve: positive dy scrolls down, negative up.
      const dy = direction === 'down' ? amount : -amount;
      await this.withLive('scroll', 'desktop', (sb) => sb.desktop.scroll({ dy }));
    },
    type: async (text) => {
      if (typeof text !== 'string') throw invalidArgument('type: text must be a string');
      await this.withLive('type', 'desktop', (sb) => sb.desktop.write(text));
    },
    press: async (key) => {
      const keys = normalizeKey(key);
      await this.withLive('press', 'desktop', (sb) => sb.desktop.press(keys));
    },
    getScreenSize: async () => {
      const shot = await this.takeScreenshot();
      return sizeOf(shot.data);
    },
    getCursorPosition: () => this.queryCursor(),
    streamUrl: () => this.liveViewUrl(),
  };

  private async takeScreenshot(): Promise<ComputerScreenshot> {
    const shot = await this.withLive('screenshot', 'desktop', (sb) => sb.desktop.screenshot());
    const size = pngSize(shot.data);
    if (shot.format !== 'png' || !size) {
      throw new SandboxError(
        `Superserve screenshot was not a PNG (format: ${shot.format}, ${shot.data.byteLength} bytes)`,
        'UNEXPECTED_SCREENSHOT',
        { format: shot.format, bytes: shot.data.byteLength },
      );
    }
    this._screenSize = size;
    return { data: shot.data, mediaType: 'image/png' };
  }

  private async pointer(
    op: string,
    x: number,
    y: number,
    fn: (desktop: SdkSandbox['desktop']) => Promise<void>,
  ): Promise<void> {
    assertCoordinate(x, y);
    await this.assertInBounds(x, y);
    await this.withLive(op, 'desktop', (sb) => fn(sb.desktop));
  }

  /**
   * Reject coordinates outside the last screen size seen. A miss re-reads the
   * size once (the display may have been resized) before rejecting. With no
   * screenshot taken yet there is nothing to check against.
   */
  private async assertInBounds(x: number, y: number): Promise<void> {
    const inside = (s: ComputerScreenSize) => x < s.width && y < s.height;
    if (!this._screenSize || inside(this._screenSize)) return;
    const fresh = await this.computer.getScreenSize();
    if (!inside(fresh)) {
      throw new SandboxError(
        `Coordinates (${x}, ${y}) are outside the ${fresh.width}x${fresh.height} display`,
        'COORDINATE_OUT_OF_BOUNDS',
        { x, y, ...fresh },
      );
    }
  }

  /**
   * Real cursor position via `xdotool getmouselocation --shell` inside the VM
   * (verified live in Phase 1). Fails loudly rather than guessing.
   */
  private async queryCursor(): Promise<ComputerPosition> {
    const result = await this.withLive(
      'getCursorPosition',
      'desktop',
      (sb) =>
        sb.commands.run(CURSOR_QUERY_COMMAND, {
          env: { DISPLAY: this._display },
          timeoutMs: DEFAULT_CURSOR_QUERY_TIMEOUT_MS,
        }),
      { timeoutMs: DEFAULT_CURSOR_QUERY_TIMEOUT_MS },
    );
    if (result.exitCode === 127) {
      throw new SandboxUnsupportedFeatureError(
        `getCursorPosition needs xdotool, which is not installed in template ${this._template}`,
        { provider: this.provider, template: this._template, stderr: result.stderr.trim() },
      );
    }
    const position = result.exitCode === 0 ? parseMouseLocation(result.stdout) : null;
    if (!position) {
      throw new SandboxError(
        `Cursor query failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
        'CURSOR_QUERY_FAILED',
        { exitCode: result.exitCode, display: this._display },
      );
    }
    return position;
  }

  /**
   * Publish the noVNC viewer (port 6080) with the configured access policy and
   * return its URL. Private URLs carry a short-lived signed credential.
   * Returns null only when the live view is disabled (`liveView: false`).
   */
  private async liveViewUrl(): Promise<string | null> {
    const access = this._liveView;
    if (access === false) return null;
    return this.withLive('streamUrl', 'desktop', async (sb) => {
      // Explicit access, so an attached VM whose default is public still gets
      // the configured policy for this port.
      await sb.publishPreviewPort(DESKTOP_STREAM_PORT, { access });
      return sb.desktop.getStreamUrl();
    });
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * Ensure the VM is running, run `fn` against it, and map SDK failures onto
   * Mastra errors. A 404 is only treated as "VM gone" after the control plane
   * confirms it.
   */
  private async withLive<T>(
    op: string,
    kind: OperationKind,
    fn: (sb: SdkSandbox) => Promise<T>,
    ctx: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    await this.ensureRunning();
    const sb = this._sandbox;
    if (!sb) throw new SandboxNotReadyError(this.id);
    try {
      return await fn(sb);
    } catch (error) {
      if (error instanceof SdkNotFoundError && (await this.confirmGone(sb))) {
        this.forgetVm();
        this.status = 'error';
        throw this.goneError(sb.id, error);
      }
      throw this.toMastraError(error, op, kind, ctx);
    }
  }

  /** Ask the control plane (without resuming) whether the VM still exists. */
  private async confirmGone(sb: SdkSandbox): Promise<boolean> {
    try {
      const info = await sb.getInfo();
      return info.status === 'deleted' || info.status === 'failed';
    } catch (probeError) {
      return probeError instanceof SdkNotFoundError;
    }
  }

  private forgetVm(): void {
    this._sandbox = null;
    this._attached = undefined;
    this._screenSize = undefined;
  }

  private goneError(sandboxId: string, cause: unknown): SandboxError {
    return withCause(
      new SandboxError(
        `Superserve sandbox ${sandboxId} no longer exists (deleted, auto-deleted, or failed)`,
        'SANDBOX_GONE',
        { provider: this.provider, sandboxId, logicalId: this.id },
      ),
      cause,
    );
  }

  private toMastraError(
    error: unknown,
    op: string,
    kind: OperationKind,
    ctx: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Error {
    if (error instanceof SandboxError) return error; // already a Mastra error
    if (ctx.signal?.aborted) return withCause(new SandboxAbortError(op, ctx.signal.reason), error);
    const sandboxId = this._attached?.sandboxId;
    const details = { provider: this.provider, operation: op, ...(sandboxId && { sandboxId }) };
    const reason = error instanceof Error ? error.message : String(error);

    if (error instanceof SdkTimeoutError) {
      if (kind === 'command' && ctx.timeoutMs !== undefined) {
        return withCause(new SandboxTimeoutError(ctx.timeoutMs, 'command'), error);
      }
      const note = kind === 'desktop' ? ' The input may still have been delivered.' : '';
      return withCause(new SandboxError(`Superserve ${op} timed out: ${reason}.${note}`, 'PROVIDER_TIMEOUT', details), error);
    }
    if (error instanceof SdkAuthenticationError) {
      return withCause(
        new SandboxError(
          `Superserve rejected the credentials during ${op} (check SUPERSERVE_API_KEY / apiKey)`,
          'PROVIDER_AUTH_FAILED',
          details,
        ),
        error,
      );
    }
    if (error instanceof SdkRateLimitError) {
      return withCause(new SandboxError(`Superserve rate limit during ${op}: ${reason}`, 'PROVIDER_RATE_LIMITED', details), error);
    }
    if (error instanceof SdkValidationError) {
      return withCause(new SandboxError(`Superserve rejected ${op}: ${reason}`, 'INVALID_ARGUMENT', details), error);
    }
    if (error instanceof SdkNotFoundError) {
      return withCause(new SandboxError(`Superserve ${op}: not found: ${reason}`, 'PROVIDER_NOT_FOUND', details), error);
    }
    return withCause(new SandboxError(`Superserve ${op} failed: ${reason}`, 'PROVIDER_ERROR', details), error);
  }

  private vmName(): string {
    const safe = this.id.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48);
    return `${this._namePrefix}-${safe}-${Date.now().toString(36)}`;
  }
}

function sizeOf(png: Uint8Array): ComputerScreenSize {
  // takeScreenshot() already verified the header.
  return pngSize(png)!;
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function withCause<E extends Error>(error: E, cause: unknown): E {
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false, configurable: true, writable: true });
  return error;
}
