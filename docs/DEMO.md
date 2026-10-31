# Mousepad demo (`pnpm example:agent`)

A Mastra agent on an OpenAI model opens Mousepad on a Superserve desktop VM,
types a short document with a unique token and saves it to
`/home/desktop/mastra-superserve-demo.txt`. The script then checks the result
independently. With `DEMO_CONTINUE=1`, a second agent continues the document
on the same VM after a pause and reconnect. This is the fallback for the
launch-brief demo ([LAUNCH-DEMO.md](LAUNCH-DEMO.md)).

```bash
# Single session
DEMO_SETUP_EDITOR=1 MAX_STEPS=15 pnpm example:agent

# Two sessions with pause/reconnect (add DEMO_VIEWER=1 to watch live)
DEMO_MODE=1 DEMO_CONTINUE=1 DEMO_SETUP_EDITOR=1 MAX_STEPS=15 pnpm example:agent

# Only check the Mousepad install on one VM (no agent, no OpenAI key needed)
DEMO_SETUP_ONLY=1 pnpm example:agent
```

## Flow

1. **Editor check.** `superserve/desktop` ships no GUI text editor. Before
   any model call, a read-only `command -v` looks for Mousepad and a few
   other editors. If none is found, the run fails without OpenAI usage,
   unless `DEMO_SETUP_EDITOR=1` lets the script install Mousepad with
   `apt-get` (passwordless `sudo`, 240 s limit). Install and verification run
   in one command, and success requires both the binary and the menu entry.
   Mousepad is installed, never started; the agent opens it itself.
2. **Session 1.** The agent opens Mousepad from the Applications menu, types
   `Mastra × Superserve` and `Verification token: <token>`, and saves with
   ctrl+s. The prompt gives no coordinates.
3. **Checks.** The agent took a screenshot, clicked, and typed the token with
   the keyboard tool. It did not start the editor or write the file from the
   shell. The script reads the file with `cat` and requires the title and the
   token.
4. **Pause and reconnect** (`DEMO_MODE=1`). The script pauses the VM, creates
   a new `SuperserveSandbox` in the same process from the saved `sandboxId`,
   reconnects, checks the file is still there and the desktop still answers.
5. **Session 2** (`DEMO_CONTINUE=1`). A new `Agent` with no memory, bound to
   the reconnected sandbox's `Workspace`. Its prompt holds only the file path,
   a heading and a new token. It reuses the Mousepad window if it survived the
   pause, or reopens the file with ctrl+o, then appends
   `Session 2: Continued after reconnect` and its token and saves.
6. **Final checks.** Same `sandboxId` throughout and exactly one VM for the
   logical id; GUI used, no shell edits or `xdotool` input; the file holds
   both sessions' content in order; the agent reported its token.
7. **Cleanup.** The VM is destroyed and its deletion confirmed with the
   Superserve API, on success, failure, model error, timeout, Ctrl-C or the
   watchdog. If cleanup itself fails, the VM id is printed for manual deletion.

## Output

`[AGENT]` lines are printed live as the model calls each tool. Only tool
names, coordinates, key names and character counts are shown; typed text,
shell commands and tool results are not. `[VM]` lines are the scripted
lifecycle, not model actions. The run ends with `[RESULT] PASS` (exit 0) or
`[RESULT] FAIL` with the failed checks (exit 1). Screenshots go to
`artifacts/` (git-ignored).

## Limits

- Session 1: `MAX_STEPS` (1–15, default 10; the editor task usually needs 15).
- Session 2: `DEMO_CONTINUE_MAX_STEPS` (1–20, default 15).
- 5 minutes per session, plus a watchdog for the whole run.

## Live viewer (`DEMO_VIEWER=1`)

Superserve's desktop viewer URL is signed and short-lived. With
`DEMO_VIEWER=1` the script serves `http://localhost:7777/` on 127.0.0.1. Each
request mints a fresh private, view-only URL and answers with a redirect, so
the signed URL is never printed. The script waits up to 2 minutes for the page
to be opened before starting the agent. The viewer disconnects while the VM
is paused; reload the page after `[VM] Reconnected`.

## Troubleshooting

- `no GUI text editor installed`: rerun with `DEMO_SETUP_EDITOR=1`.
- `editor setup failed at <step> (<category>)`: `unsupported` (no `apt-get`
  or root), `apt-failed`, `apt-timeout`, `verify-failed`, `incomplete`, or a
  request failure (`network`, `disconnect`, `command-timeout`). No model calls
  were made.
- `FAIL during <phase>` names the scripted step that failed, with a redacted
  cause chain.
- Title check fails but the token is present: the `×` character did not come
  through the keyboard tool. The printed file contents show what was saved.
