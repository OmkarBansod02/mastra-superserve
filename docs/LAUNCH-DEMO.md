# Launch-brief demo (`pnpm example:launch`)

Two independent Mastra agent sessions on one Superserve desktop VM, with the
VM paused and reconnected by `sandboxId` between them. Every desktop action is
a `mastra_workspace_computer_*` tool call chosen by the model. The prompts give
no coordinates, and no application input is scripted.

```bash
DEMO_SETUP_EDITOR=1 pnpm example:launch
DEMO_SETUP_EDITOR=1 DEMO_VIEWER=1 pnpm example:launch   # watch at http://localhost:7777/
```

The Mousepad demo in [DEMO.md](DEMO.md) is the fallback.

## Session 1: draft the brief

The agent opens Mousepad from the Applications menu, types this brief and
saves it to `/home/desktop/launch-brief.txt`:

```
MASTRA x SUPERSERVE
PROJECT LAUNCH BRIEF
----------------------------------

OVERVIEW
Native computer-use integration for persistent AI agents.

BUDGET
Design       $400
Hosting      $150
Promotion    $250

----------------------------------
NEXT: Finalize budget and launch summary.
```

The amounts are chosen at random per run (design 300–500, hosting 100–200,
promotion 200–300), so the total can't be known in advance. All text is plain
ASCII so it doesn't depend on keyboard mapping or fonts.

## Pause and reconnect

The script pauses the VM, creates a new `SuperserveSandbox` from the saved
`sandboxId`, reconnects, and checks that the brief is still on disk and that
Superserve lists exactly one VM for the sandbox.

## Session 2: complete it

A new `Agent` with no memory. Its prompt names the file, the `NEXT:`
convention and the section layout with a `<total>` placeholder, but contains
no amounts, no total and no Session 1 text. The agent reads the brief (from
the screen, or with a read-only `cat`), adds up the amounts and appends:

```

----------------------------------
SESSION 02 / COMPLETED

TOTAL BUDGET   $800
STATUS         READY FOR LAUNCH

Budget reviewed. Launch summary complete.
```

Edits are append-only (ctrl+End, Enter, type).

## Text entry

The prompts ask for one type-tool call per line and one Enter key press
between lines, never a newline inside typed text. Each agent run passes
`toolCallConcurrency: 1` to Mastra. Mastra runs a step's tool calls
concurrently by default, so several `type` and `Enter` calls in one step could
reach the editor out of order. With the setting, they run in the order the
model emitted them. `test/launch-demo.test.ts` reproduces the reordering with
the default setting and shows the fix.

To save tokens, the type tool returns no screenshot after each call
(`LAUNCH_TOOLS`). Clicks and key presses still return one.

## Checks

Text must match line for line: every heading, label and amount, in order.
Differences in blank lines and spacing are logged as notes and don't fail the
run.

- **After Session 1** (Session 2 only runs if these pass): screenshot taken,
  desktop clicked, Mousepad not started from the shell, file not written from
  the shell, no `xdotool` input, the file holds the brief in order (read with
  `cat` outside the agent), no Session 2 content yet.
- **After Session 2:** same `sandboxId` before the pause, after the reconnect
  and at the end, with one VM listed; the same GUI and shell rules; the brief
  unchanged at the top; one COMPLETED section after it; **the total equals the
  sum of the amounts**; the agent's answer states the total.

When the file's text is wrong, the log shows the first differing line and
replays the session's own type and Enter calls to tell a model mistake apart
from lost or reordered input.

## Display settings (best-effort)

Unless `LAUNCH_EDITOR_LOOK=0`, the script (not the model) sets Mousepad's font
to `Monospace 16`, makes it open maximized and hides desktop icons, so the
whole 22-line document is readable at 1280x800. Each setting is read back and
reported; if one doesn't stick, the run continues. These settings have not yet
been confirmed on a live VM.

## Output and artifacts

The terminal shows banners for Session 1, the pause/reconnect and Session 2,
then `[S1]` / `[S2]` lines for each tool call (names, coordinates, key names,
character counts; never typed text or tool results), the checks, and
`[RESULT] PASS` or `FAIL`. Three screenshots go to `artifacts/` (git-ignored).

## Limits and cleanup

- Step budgets: `LAUNCH_S1_MAX_STEPS` (default 38) and `LAUNCH_S2_MAX_STEPS`
  (default 30), each 1–40. That covers about one tool call per step plus a
  few retries.
- 6 minutes per session. The VM auto-pause timeout is raised above the
  900 s default only when setup and the viewer wait need it.
- With `DEMO_VIEWER=1`, the script waits up to 2 minutes for the viewer before
  Session 1, and up to 1 minute for a reload before Session 2.
- The VM is destroyed and its deletion confirmed on success, a failed check, a
  model error, a timeout, Ctrl-C or the watchdog. Failures print
  `FAIL during <phase>` or the failed checks, then `[RESULT] FAIL` (exit 1).
