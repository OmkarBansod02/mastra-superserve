# mastra-superserve

A [Mastra](https://mastra.ai) sandbox provider that runs agents on
[Superserve](https://superserve.ai) cloud desktop VMs.

Attach a `SuperserveSandbox` to a Mastra `Workspace` and your agent can run
shell commands, write files, and operate a Linux desktop through Mastra's
built-in computer-use tools (screenshot, mouse, keyboard). You don't write any
tools yourself.

> **Unofficial community integration.** Not built, endorsed or supported by
> Mastra or Superserve. Not published to npm.

## How it fits together

```
Mastra Agent
   │  mastra_workspace_computer_* and mastra_workspace_execute_command tool calls
   ▼
Mastra Workspace
   ▼
SuperserveSandbox            (this package: extends MastraSandbox, implements SandboxComputer)
   │  Superserve SDK (@superserve/sdk)
   ▼
Superserve VM                (superserve/desktop template: Ubuntu + XFCE, X display :1)
```

Mastra defines the sandbox interface (`MastraSandbox`) and the computer-use
interface (`SandboxComputer`). When a `Workspace` has a sandbox with a
`computer`, Mastra gives the agent these tools:
`mastra_workspace_execute_command` and
`mastra_workspace_computer_{screenshot, click, double_click, right_click, move_mouse, drag, scroll, type, press_key, get_screen_info, wait}`.

`SuperserveSandbox` implements both interfaces on top of the Superserve SDK,
so those tool calls become Superserve API calls against one VM.

## What the provider implements

| Area | Behaviour |
| --- | --- |
| Lifecycle | VM created lazily on first use. `stop()` pauses it, `destroy()` kills it if this instance owns it. |
| Reconnect | Reattach to a VM by Superserve VM id (`sandboxId`) or by a stable logical Mastra id (`id`). |
| Commands | `executeCommand` with cwd, env, timeout, abort signal and streamed stdout/stderr. |
| Files | `writeFiles` as the desktop user: parent dirs created, checksummed, atomic rename. |
| Computer use | Screenshot (PNG), left/right/double click, move, drag, scroll, type, key press, screen size, cursor position. |
| Live view | `computer.streamUrl()` returns a noVNC viewer URL (private by default; can be disabled). |
| Safety | New VMs auto-pause after 15 min active and auto-delete after 10 min paused (both configurable). |
| Errors | Superserve SDK errors are mapped to Mastra `SandboxError` types. |

`stop()` and reconnect keep the VM's memory, disk and running processes,
because Superserve pauses and resumes the same VM.

## Requirements

- Node.js 22.13 or later (CI runs Node 22 and 24)
- pnpm 9 (`corepack enable` picks up the pinned version)
- `@mastra/core` `>=1.80.0 <2` as a peer dependency (developed against 1.80.0)
- A Superserve API key. An OpenAI API key is needed only for the agent examples.

## Install

The package is not on npm. Build it from source:

```bash
git clone https://github.com/OmkarBansod02/mastra-superserve.git
cd mastra-superserve
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

To use it from another project:

```bash
pnpm add /path/to/mastra-superserve @mastra/core zod
```

## Usage

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
  workspace,
});

try {
  const result = await agent.generate('Take a screenshot and describe the desktop.', { maxSteps: 5 });
  console.log(result.text);
} finally {
  await workspace.destroy(); // kills the VM this sandbox created
}
```

The sandbox can also be used directly:

```ts
await sandbox.start();
await sandbox.executeCommand('uname', ['-a']);
await sandbox.writeFiles([{ path: '/home/desktop/notes.txt', content: 'hello' }]);
await sandbox.computer.screenshot(); // { data: Uint8Array, mediaType: 'image/png' }
await sandbox.computer.leftClick(100, 200);
await sandbox.computer.type('hello');
await sandbox.computer.press('Enter');
await sandbox.destroy();
```

### Pause and reconnect

```ts
const first = new SuperserveSandbox({ autoDeleteSeconds: 3600 });
await first.start();
const vmId = first.sandboxId!; // persist this
await first.stop();            // pause

// Later, possibly in another process:
const again = new SuperserveSandbox({ sandboxId: vmId });
await again.start();           // resumes the same VM
await again.destroy();
```

Or pass a stable logical id (`new SuperserveSandbox({ id: 'user-42-desktop' })`):
`start()` resumes the VM tagged with that id, or creates one.

### Options

All optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | random | Logical Mastra id. When set, `start()` first resumes a VM tagged with it. |
| `sandboxId` | — | Superserve VM id to reattach to. |
| `reattach` | `'required'` | If `sandboxId` no longer exists: `'required'` throws, `'best-effort'` falls back to lookup/create. |
| `killOnDestroy` | `'owned'` | `'owned'` kills VMs this provider created or tagged; `'always'`; `'never'`. |
| `template` | `'superserve/desktop'` | VM template. Only this one has been tested. |
| `timeoutSeconds` | `900` | Auto-pause after this long active. Cannot be disabled. |
| `autoDeleteSeconds` | `600` | Auto-delete after this long paused. `null` keeps paused VMs. |
| `liveView` | `'private'` | Viewer access: `'private'`, `'public'` or `false`. `'public'` lets anyone with the URL control the desktop. |
| `commandTimeoutMs` | `60000` | Default command timeout. |
| `metadata`, `namePrefix`, `display`, `apiKey`, `baseUrl` | | See the JSDoc in `src/sandbox.ts`. |

## Examples

Both examples run a Mastra agent on an OpenAI model against one real
Superserve VM. They cost OpenAI and Superserve usage, cap model steps and wall
time, always destroy the VM at the end (including on failure and Ctrl-C), and
never print API keys or viewer URLs. Without the required keys they print
`Skipping` and exit 0.

```bash
cp .env.example .env   # set SUPERSERVE_API_KEY and OPENAI_API_KEY
```

The `superserve/desktop` template ships no GUI text editor. Set
`DEMO_SETUP_EDITOR=1` to have the script (not the agent) install Mousepad
before the agent starts.

### Two-session demo

Two separate Mastra agents work on the same document, on the same VM, with a
pause and reconnect between them:

1. **Session 1.** An agent opens Mousepad through the desktop menu, types a
   document and saves it. Every click and keystroke is a tool call chosen by
   the model; no coordinates are given.
2. **Pause and reconnect.** The script pauses the VM, creates a new
   `SuperserveSandbox` from the saved `sandboxId` and reconnects to the same VM.
3. **Session 2.** A new agent with no memory of Session 1 continues the
   document through the GUI. Only the VM's state carries over.
4. **Verification.** The script reads the file itself with a read-only `cat`
   and checks the content, that the same VM was used throughout, and that the
   agents used the GUI rather than shell writes. Then it destroys the VM.

Two variants:

```bash
# Launch brief: Session 1 drafts a budget brief, Session 2 reads it and adds the total.
DEMO_SETUP_EDITOR=1 pnpm example:launch

# Fallback: a shorter Mousepad document with a verification token per session.
DEMO_MODE=1 DEMO_CONTINUE=1 DEMO_SETUP_EDITOR=1 MAX_STEPS=15 pnpm example:agent
```

Add `DEMO_VIEWER=1` to watch the desktop live at `http://localhost:7777/`
(a local redirect to a private, view-only viewer). Details:
[docs/LAUNCH-DEMO.md](docs/LAUNCH-DEMO.md) and [docs/DEMO.md](docs/DEMO.md).

## Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `SUPERSERVE_API_KEY` | provider, examples, smoke tests | Required to create or attach VMs. Can also be passed as `apiKey`. |
| `SUPERSERVE_BASE_URL` | provider | Optional API endpoint override (`baseUrl`). |
| `OPENAI_API_KEY` | examples | Required for the agent examples. |
| `OPENAI_MODEL` | examples | Default `gpt-5.4-mini`. Needs tool calls and image input. |
| `DEMO_SETUP_EDITOR` | examples | `1` installs Mousepad if no GUI editor is found. |
| `DEMO_VIEWER`, `DEMO_VIEWER_PORT` | examples | `1` serves a local redirect to a view-only viewer (port 7777). `example:agent` needs `DEMO_MODE=1`. |
| `LAUNCH_S1_MAX_STEPS`, `LAUNCH_S2_MAX_STEPS` | `example:launch` | Step budgets per session (default 38 / 30, max 40). |
| `LAUNCH_EDITOR_LOOK` | `example:launch` | `0` skips the larger editor font and maximized window. |
| `MAX_STEPS` | `example:agent` | Session 1 step budget, 1–15 (default 10). |
| `DEMO_MODE`, `DEMO_CONTINUE`, `DEMO_CONTINUE_MAX_STEPS` | `example:agent` | Enable the pause/reconnect showcase and Session 2 (default 15 steps, max 20). |
| `DEMO_SETUP_ONLY` | `example:agent` | `1` only installs and verifies Mousepad on one VM. No agent, no OpenAI calls. |
| `DEBUG_IMAGES` | `example:agent` | `1` logs screenshot ids and sizes sent to the model. |

## Tests

```bash
pnpm typecheck
pnpm test       # unit tests against fakes; network blocked, no keys needed
pnpm build
```

CI runs these on Node 22 and 24. The unit tests cover the provider and both
demos end to end, using a fake Superserve SDK and a scripted stand-in for the
model.

Live checks create real VMs, need `SUPERSERVE_API_KEY`, and are never run in
CI:

```bash
pnpm smoke   # raw Superserve SDK desktop smoke test
pnpm e2e     # SuperserveSandbox inside a Mastra Workspace, driven through Mastra's tools
```

Live runs write screenshots and results to `artifacts/` (git-ignored).

## Limitations

- Not published to npm; install from source.
- Only the `superserve/desktop` template has been tested.
- Only OpenAI models have been tried with the agent examples.
- Background processes (`MastraSandbox` `processes`) are not implemented; use
  `executeCommand`.
- `writeFiles` writes as the desktop user, so paths that user cannot write
  fail with `WRITE_FAILED`. Per-file `mode` is rejected.
- `executeCommand` always has a timeout (Superserve has no unbounded commands).
  When output exceeds Superserve's cap, both streams are flagged truncated.
- `getCursorPosition` needs `xdotool` in the template.
- Auto-pause cannot be disabled; long-running agents must tolerate a resume.
- The launch demo's display settings (editor font, maximized window) are
  best-effort and have not been confirmed on a live VM.

## License

[Apache-2.0](LICENSE). `@mastra/core` and `@superserve/sdk` are also
Apache-2.0.

Mastra and Superserve are trademarks of their respective owners.
