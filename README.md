# mastra-superserve

A [Mastra](https://mastra.ai) workspace sandbox provider backed by
[Superserve](https://superserve.ai) cloud desktop VMs.

`SuperserveSandbox` gives a Mastra `Workspace` a Linux desktop running in a
Superserve VM. Agents that use the workspace get shell commands, file writes and
Mastra's built-in computer-use tools (screenshot, mouse, keyboard), with no
hand-written tools.

> **Unofficial.** This is a community integration. It is not built, endorsed or
> supported by Superserve or Mastra. It is not published to npm yet.

## Why use it

- Give a Mastra agent a real graphical desktop to operate, not only a shell.
- Use Mastra's standard workspace tools; the agent code does not change if you
  swap sandbox providers.
- Keep VM lifetime under control: VMs are created lazily, auto-pause and
  auto-delete by default, and are only killed by the instance that owns them.
- Pause a VM and reattach to it later, with memory, disk and processes intact.

## Features

| Area | Supported |
| --- | --- |
| Shell | `executeCommand` with cwd, env, timeout, abort signal, streaming stdout/stderr |
| Files | `writeFiles` as the desktop user (atomic, checksummed, parent dirs created) |
| Computer use | screenshot (PNG), left/right/double click, move, drag, scroll, type, key press, screen size, cursor position |
| Live view | `computer.streamUrl()` returns a noVNC viewer URL (private by default, can be disabled) |
| Lifecycle | lazy start, `stop()` = pause, `destroy()` = kill when owned |
| Persistence | reattach by Superserve VM id (`sandboxId`) or by logical Mastra id (`id`) |
| Errors | Superserve SDK errors mapped to Mastra `SandboxError` types |

When the sandbox is attached to a `Workspace`, Mastra injects these tools into
the agent: `mastra_workspace_execute_command` and
`mastra_workspace_computer_{screenshot, click, double_click, right_click,
move_mouse, drag, scroll, type, press_key, get_screen_info, wait}`.

## Architecture

```
Mastra Agent
   │  tool calls (mastra_workspace_computer_*, execute_command)
   ▼
Mastra Workspace  ──►  SuperserveSandbox  (this package, extends MastraSandbox)
                          │  @superserve/sdk
                          ▼
                     Superserve API  ──►  Firecracker microVM
                                           (superserve/desktop template, X display :1)
```

- `src/sandbox.ts`: the provider. Lifecycle (find → connect, else create),
  commands, file writes, the `computer` capability and error mapping.
- `src/utils.ts`: key-name normalisation, argument validation, PNG size
  parsing, and the in-VM file-write script.
- Two ids are kept separate: `id` is the logical Mastra sandbox id (stored in
  VM metadata as `mastra-sandbox-id`); `sandboxId` is the physical Superserve
  VM UUID.
- Ownership decides what `destroy()` does: `created` and `adopted` VMs are
  killed; `borrowed` VMs (untagged VMs created outside Mastra) are only
  detached. Override with `killOnDestroy`.

## Requirements

- Node.js **22.13 or later** (matches `@mastra/core`'s `engines`). CI runs on
  Node 22 and 24.
- pnpm 9 (the repo pins `pnpm@9.15.4` via `packageManager`; `corepack enable`
  picks it up).
- `@mastra/core` `>=1.80.0 <2` as a peer dependency. Developed and tested
  against 1.80.0.
- A Superserve API key for anything that starts a VM.
- An OpenAI API key only for the OpenAI agent example.

## Installation

The package is not on npm. Build it from source:

```bash
git clone https://github.com/OmkarBansod02/mastra-superserve.git
cd mastra-superserve
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

To use it from another project, install the local checkout next to Mastra:

```bash
pnpm add /path/to/mastra-superserve @mastra/core
```

The package is ESM-only and exports `SuperserveSandbox`, its option and
ownership types, `normalizeKey`, and the defaults (`DEFAULT_TEMPLATE`,
`DEFAULT_TIMEOUT_SECONDS`, `DEFAULT_AUTO_DELETE_SECONDS`, `DEFAULT_DISPLAY`,
`SANDBOX_ID_METADATA_KEY`).

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored.

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPERSERVE_API_KEY` | provider, examples, smoke tests | Required to create or attach VMs. Can also be passed as the `apiKey` option. |
| `SUPERSERVE_BASE_URL` | provider | Optional API endpoint override (`baseUrl` option). |
| `OPENAI_API_KEY` | `example:agent` | Required only for the OpenAI agent. |
| `OPENAI_MODEL` | `example:agent` | Default `gpt-5.4-mini`. Must support tool calls and image input. |
| `MAX_STEPS` | `example:agent` | Agent step budget, 1–15. Default 10. |
| `DEBUG_IMAGES` | `example:agent` | `1` to log screenshots sent to OpenAI (ids and sizes only). |

Main `SuperserveSandbox` options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | random | Logical Mastra id. When set, `start()` first resumes a VM tagged with it. |
| `sandboxId` | — | Superserve VM UUID to reattach to. |
| `reattach` | `'required'` | If `sandboxId` is gone: `'required'` throws, `'best-effort'` falls back to lookup/create. |
| `killOnDestroy` | `'owned'` | `'owned'`, `'always'` or `'never'`. |
| `template` | `'superserve/desktop'` | VM template. |
| `timeoutSeconds` | `900` | Auto-pause after this long active. Cannot be disabled. |
| `autoDeleteSeconds` | `600` | Auto-delete after this long paused. `null` keeps paused VMs. |
| `liveView` | `'private'` | Viewer access: `'private'`, `'public'` or `false`. `'public'` lets anyone with the URL control the desktop. |
| `commandTimeoutMs` | `60000` | Default command timeout. |
| `metadata`, `namePrefix`, `display`, `apiKey`, `baseUrl` | | See the JSDoc in `src/sandbox.ts`. |

## Minimal Mastra example

```ts
import { Agent } from '@mastra/core/agent';
import { Workspace } from '@mastra/core/workspace';
import { SuperserveSandbox } from 'mastra-superserve';

const sandbox = new SuperserveSandbox(); // reads SUPERSERVE_API_KEY
const workspace = new Workspace({ sandbox });

const agent = new Agent({
  id: 'desktop-agent',
  name: 'Desktop agent',
  instructions: 'You operate a Linux desktop through the computer tools. Take a screenshot before acting.',
  model: 'openai/gpt-5.4-mini',
  workspace, // adds the computer and execute_command tools
});

try {
  const result = await agent.generate('Take a screenshot and describe the desktop.', { maxSteps: 5 });
  console.log(result.text);
} finally {
  await workspace.destroy(); // kills the VM this sandbox created
}
```

No VM is created until the first tool call (or an explicit `start()`).

The sandbox can also be used directly:

```ts
await sandbox.start();
const { stdout } = await sandbox.executeCommand('uname', ['-a']);
await sandbox.writeFiles([{ path: '/home/desktop/notes.txt', content: 'hello' }]);
const shot = await sandbox.computer.screenshot(); // { data: Uint8Array, mediaType: 'image/png' }
await sandbox.computer.leftClick(100, 200);
await sandbox.computer.type('hello');
await sandbox.computer.press('Enter');
await sandbox.destroy();
```

## OpenAI computer-use agent

`examples/agent.ts` runs a Mastra agent on an OpenAI model against one VM.
The agent takes a screenshot, opens a terminal through the desktop, types
a command that writes a unique token to `/tmp/mastra-agent-demo.txt`, and
checks the file. The script then verifies the result independently.

```bash
cp .env.example .env   # set SUPERSERVE_API_KEY and OPENAI_API_KEY
pnpm example:agent
```

- Creates one VM and destroys it on success, failure, Ctrl-C or watchdog
  timeout. If cleanup fails, it prints the VM id to delete manually.
- Bounded: at most `MAX_STEPS` (≤ 15) model steps, a 5-minute run limit, and
  a VM auto-pause after 10 minutes.
- Exits 0 with `PASS` when every check passes, 1 with `FAIL` and the failed
  checks otherwise. Without both keys it prints `Skipping` and exits 0.
- Never prints API keys or live-viewer URLs.

This uses paid OpenAI and Superserve resources. See
[docs/DEMO.md](docs/DEMO.md) for a recording checklist.

## Persistence and reconnect

`stop()` pauses the VM; memory, disk and running processes are kept. Persist
`sandbox.sandboxId` and pass it back later to reattach:

```ts
const first = new SuperserveSandbox({ autoDeleteSeconds: 3600 });
await first.start();
await first.executeCommand('echo state > /tmp/state.txt');
const vmId = first.sandboxId!; // store this
await first.stop(); // pause; auto-delete starts counting

// Later, possibly in another process:
const again = new SuperserveSandbox({ sandboxId: vmId });
await again.start(); // resumes the same VM
console.log((await again.executeCommand('cat /tmp/state.txt')).stdout); // "state"
await again.destroy(); // kills it (it was created by a Mastra sandbox)
```

Alternatively give the sandbox a stable logical `id`
(`new SuperserveSandbox({ id: 'user-42-desktop' })`); `start()` resumes a VM
tagged with that id, or creates one.

A paused VM is deleted after `autoDeleteSeconds` (600 by default). Reattaching
to a deleted VM throws (`reattach: 'required'`) or creates a new VM
(`reattach: 'best-effort'`).

## Testing

```bash
pnpm typecheck
pnpm test        # unit tests: fakes only, network access blocked, no keys needed
pnpm build
```

Live checks create real VMs and need `SUPERSERVE_API_KEY`. They are never run
in CI. Each one cleans up its VM.

```bash
pnpm smoke           # smoke/phase1.ts: raw SDK desktop smoke test
pnpm e2e             # examples/workspace-e2e.ts: provider inside a Mastra Workspace
pnpm example:agent   # also needs OPENAI_API_KEY
```

Live runs write screenshots and results to `artifacts/` (git-ignored).

## Known limitations

- Not published to npm; install from source.
- Only the `superserve/desktop` template has been tested.
- Background process management (`processes`) is not implemented; use
  `executeCommand`.
- `writeFiles` writes as the desktop user: paths that user cannot write fail
  with `WRITE_FAILED`. Per-file `mode` is rejected.
- `executeCommand` always has a timeout (Superserve has no unbounded commands).
  When output exceeds Superserve's cap, both streams are flagged truncated.
- `getCursorPosition` needs `xdotool` in the template.
- Auto-pause cannot be disabled; long-running agents must tolerate a resume.
- Only OpenAI models have been tried with the agent example.

## License

[Apache-2.0](LICENSE). Dependencies `@mastra/core` and `@superserve/sdk` are
Apache-2.0 as well (`@mastra/core`'s `ee/` directories are under a separate
license and are not used here).

Mastra and Superserve are trademarks of their respective owners.
