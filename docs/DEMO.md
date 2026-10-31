# Demo recording checklist

Records `pnpm example:agent` in demo mode: a Mastra agent on an OpenAI model
operating a Superserve desktop VM, followed by a scripted pause/reattach
lifecycle. One run creates one VM and makes at most `MAX_STEPS` model calls.

## What the run shows

```
[VM] Created (sandbox 1a2b3c4d)
[SETUP] No GUI text editor found; DEMO_SETUP_EDITOR=1, installing Mousepad
[SETUP] apt-get available; installing Mousepad as root via passwordless sudo (limit 240s)
[SETUP] apt-get exited 0 in …s (dpkg set up mousepad)
[SETUP] Mousepad installed: /usr/bin/mousepad, menu entry … (verified in the same command)
[ENV] GUI text editor found: Mousepad (mousepad)
[VIEWER] Open http://localhost:7777/ in your browser (waiting up to 2 min)
[VIEWER] Opened (private, view-only); starting the agent in 5s
[AGENT] computer_screenshot
[AGENT] computer_click (…)            Applications menu or app finder
[AGENT] computer_click (…)            the editor entry
[AGENT] computer_click (…)            the text area
[AGENT] computer_type (19 chars)      Mastra × Superserve
[AGENT] computer_press_key Enter
[AGENT] computer_type (…)             Verification token: …
[AGENT] computer_press_key ctrl+s
[AGENT] computer_type (…)             the save path
[AGENT] computer_press_key Enter
[AGENT] execute_command               cat (read-only check)
...independent checks, PASS: the agent completed the desktop task
--- persistence showcase (scripted lifecycle, not agent actions) ---
[VM] File verified: /home/desktop/mastra-superserve-demo.txt
[VM] Paused (Superserve reports: paused)
[VM] New provider instance created from saved sandboxId 1a2b3c4d
[VM] Reconnected to same sandbox 1a2b3c4d (ownership: adopted)
[VM] State preserved: /home/desktop/mastra-superserve-demo.txt still holds the agent's token
[VM] Desktop responsive: 1280x800 screenshot, cursor at (…)
[VM] Destroyed (sandbox 1a2b3c4d no longer listed by Superserve)
[RESULT] PASS
```

The right-hand notes are illustrative, not printed. The exact clicks and
their order are the model's choice and vary between runs.

## The task

The model is asked to open a GUI text editor through the desktop (the
Applications menu or the application finder), type two lines,
`Mastra × Superserve` and `Verification token: <unique token>`, and save them
with ctrl+s to `/home/desktop/mastra-superserve-demo.txt`. The prompt names
the editor but gives no coordinates; every click and key is the model's.

- **Editor availability.** Superserve documents `superserve/desktop` as
  Ubuntu 24.04 with `xfce4`, `xfce4-terminal` and Chrome, and lists no text
  editor. Before the agent starts, one read-only `command -v` check looks for
  Mousepad, then GNOME Text Editor, gedit, Xed, Pluma, FeatherPad and Leafpad.
  If none is found the run prints `FAIL: … no GUI text editor installed`,
  destroys the VM and makes no OpenAI calls. Nothing is installed unless
  `DEMO_SETUP_EDITOR=1` is set.
- **Editor setup (`DEMO_SETUP_EDITOR=1`).** Only when no editor is found, the
  script (not the model) checks for `apt-get` and root access (root, or
  passwordless `sudo -n`), runs `apt-get update` and
  `apt-get install --no-install-recommends mousepad` non-interactively under a
  240 s limit, then requires `mousepad` on the PATH and the editor launcher
  `/usr/share/applications/org.xfce.mousepad.desktop` (the
  `org.xfce.mousepad-settings.desktop` preferences entry does not count). Install and check run in one streamed command
  that prints status lines; success needs all of them, not just exit code 0. Every step is logged as `[SETUP]`. If any step
  is unsupported or fails, the run prints `FAIL: … editor setup failed: …`,
  destroys the VM and makes no OpenAI calls. Mousepad is installed but never
  started; the agent still opens it through the desktop.
- **Checks after the agent (all must pass):** it took a screenshot, clicked,
  typed the token with the keyboard tool, did not start the editor from the
  shell, and did not write the file from the shell. Then the script reads the
  file itself (`cat`, read-only) and requires both the token and the exact
  `Mastra × Superserve` title. `[info]` also shows whether it saved with
  ctrl+s.
- **Pause/resume.** The showcase checks the saved file and that the desktop
  answers screenshot, screen-size and cursor queries after reattaching. It
  does not check that the editor window survived; the
  `demo-2-after-reconnect.png` screenshot shows whatever is on screen.

- `[AGENT]` lines are printed live from Mastra's `onChunk` stream as the
  model calls each tool. Only coordinates, key names and scroll direction are
  shown. Typed text and shell commands are reduced to a length or left out,
  and tool results (including screenshots) are never printed.
- The `[VM]` lifecycle is run by the script, not chosen by the model. The
  "new provider instance" is a second `SuperserveSandbox` in the same Node
  process, built only from the saved `sandboxId` and logical id. No process
  restart takes place.
- `[VM] Destroyed` is printed only after the Superserve API stops listing the
  VM.
- Two screenshots are saved to `artifacts/` (git-ignored):
  `demo-1-after-agent.png` and `demo-2-after-reconnect.png`.

## Live viewer

Superserve's docs describe no dashboard desktop viewer. The documented viewer
is the SDK's `desktop.getStreamUrl()`, which returns a 60-second signed URL
under the `private` policy. `DEMO_VIEWER=1` handles it without exposing the
URL:

- The script serves `http://localhost:7777/` on 127.0.0.1 only. Each request
  publishes port 6080 as `private`, mints a fresh view-only URL and replies
  with a 302 redirect. The signed URL never reaches the terminal, logs, or a
  command line.
- Per Superserve's docs, the edge swaps the token for a cookie on the first
  request and redirects to the same URL without it, so the address bar ends
  up token-free.
- The viewer is view-only, so a stray click while recording cannot interfere
  with the agent.
- While the VM is paused or reconnecting, the page answers 503 instead of
  resuming the VM.

From WSL2, a Windows browser reaches `http://localhost:7777/` through WSL's
default localhost forwarding.

## Before recording

- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` pass.
- [ ] A private dry run passed with the editor task (see below).
- [ ] `.env` has `SUPERSERVE_API_KEY` and `OPENAI_API_KEY`. Never open or `cat`
      it on screen; clear terminal history and scrollback.
- [ ] No VMs are left over from earlier runs (check the Superserve dashboard).
- [ ] Large terminal font; window wide enough that lines don't wrap.
- [ ] Browser window placed next to the terminal, with
      `http://localhost:7777/` typed in the address bar but not loaded yet.
      Use F11 (fullscreen) once the viewer is open, or crop the recording to
      the page content, so the address bar stays out of frame.

## Run

```bash
MAX_STEPS=15 DEMO_MODE=1 DEMO_VIEWER=1 DEMO_SETUP_EDITOR=1 pnpm example:agent
```

`superserve/desktop` ships no GUI text editor, so `DEMO_SETUP_EDITOR=1` is
needed there. The install runs before the viewer wait, so open the viewer
after the `[SETUP]` lines.

### Setup-only check (no agent, no OpenAI)

To check the Mousepad install on a live VM before a recording:

```bash
DEMO_SETUP_ONLY=1 pnpm example:agent
```

It creates one VM, installs and verifies Mousepad (even if an editor is
already present), checks again with a separate read-only command, prints
`[SETUP] PASS` or `[SETUP] FAIL …`, destroys the VM and ends with
`[RESULT] PASS|FAIL`. No Mastra agent is created, no OpenAI call is made
(`OPENAI_API_KEY` is not needed), no viewer is started and the VM is never
paused or reconnected. Other `DEMO_*` flags are ignored in this mode.

The editor task needs more steps than the old terminal task (menu, entry,
text area, two lines, save dialog, check), so set `MAX_STEPS=15`, the
existing maximum. The default of 10 may run out before the file is saved.

When `[VIEWER] Open http://localhost:7777/` appears, load that tab. The agent
starts 5 seconds after the viewer opens. If it is not opened within 2
minutes, the run stops with `FAIL during viewer` (no model calls) and the VM is
destroyed. The viewer disconnects when the VM pauses. Reloading `http://localhost:7777/` after
`[VM] Reconnected` shows the same desktop again.

Without the live viewer: `DEMO_MODE=1 pnpm example:agent`. Show the two
`artifacts/demo-*.png` screenshots afterwards as visual proof.

## If it fails

- `FAIL: … no GUI text editor installed` means the template has no editor
  this demo knows. Rerun with `DEMO_SETUP_EDITOR=1`.
- `FAIL during editor setup: … editor setup failed at <step> (<category>): …`
  names the step (`probe`, `install` or `verify`) and why it failed:
  `unsupported` (no `apt-get` or no root access), `apt-failed` (last lines
  shown, e.g. no network to the Ubuntu mirrors), `apt-timeout` (the 240 s
  limit), `verify-failed` (apt-get exited 0 but the binary or menu entry is
  missing), `incomplete` (the command returned without its status lines,
  e.g. the stream lost its exit code; never counted as success), or a failed
  Superserve request: `network` (no response, e.g. a reset connection),
  `disconnect` (response cut off), `command-timeout`. Request failures include
  the error's cause chain (names, codes and messages, with URLs, hosts,
  addresses and tokens redacted). The read-only editor check after setup is
  retried once after `network`/`disconnect`; the install never is. No model
  calls were made.
- Any other `FAIL during <phase>: …` line names the scripted step that was
  running (VM start, editor preflight, viewer, agent run, …) and the same
  redacted cause chain.
- A failed `"Mastra × Superserve"` check with the token present usually means
  the `×` character did not come through the keyboard tool. The printed file
  contents show what was saved.
- The script prints `[VM] FAILED: <step>` or the failed agent checks, then
  `[RESULT] FAIL` with exit code 1. It still destroys the VM.
- If cleanup itself fails, it prints the VM id. Delete that VM manually.
- Ctrl-C also destroys the VM before exiting. A watchdog ends the run if it
  overruns its time budget (5 min agent + 2 min cleanup, plus 3 min in demo
  mode, 2 more with the viewer and 5 more with `DEMO_SETUP_EDITOR`).
- Do not rerun repeatedly in a loop; each run costs OpenAI and Superserve
  usage.

## Normal mode

Without `DEMO_MODE`, `pnpm example:agent` behaves as before: it prints a
post-run list of tool calls with their arguments, runs the checks, prints
`PASS`/`FAIL`, and cleans up. `DEBUG_IMAGES=1` works in both modes.
