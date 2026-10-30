# Demo recording checklist

Records `pnpm example:agent`: a Mastra agent on an OpenAI model operating a
Superserve desktop VM. One run creates one VM and makes at most `MAX_STEPS`
model calls.

## Before recording

- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` pass.
- [ ] `.env` has `SUPERSERVE_API_KEY` and `OPENAI_API_KEY`. Never open or `cat`
      it on screen; clear terminal history and scrollback.
- [ ] No VMs are left over from earlier runs (check the Superserve dashboard).
- [ ] Optional: `DEBUG_IMAGES=1` to show screenshots reaching the model.
- [ ] Large terminal font; window wide enough that tool-call lines don't wrap.
- [ ] If you show the live desktop, use a viewer that keeps its URL off screen.
      The script never prints viewer URLs, and a private viewer URL carries a
      credential.

## Run

```bash
DEBUG_IMAGES=1 pnpm example:agent
```

## What to capture

1. **Agent observing the desktop**: tool-call lines with
   `computer_screenshot`; with `DEBUG_IMAGES=1`, the
   `screenshots sent to OpenAI as input_image: N` line.
2. **Agent using mouse and keyboard**: `computer_click` /
   `computer_double_click` opening the terminal, `computer_type` with the
   `echo mastra-openai-… > /tmp/mastra-agent-demo.txt` command, and
   `computer_press_key` with `Enter`.
3. **Task verification**: the `execute_command` `cat` call, the
   `agent answer: "RESULT: …"` line, the `[ok]` checks (including the
   independent file check outside the agent), and `PASS`.
4. **VM cleanup**: `cleanup: VM destroyed (status: destroyed)`, then the
   Superserve dashboard showing no remaining VM.

## If it fails

- The script exits 1 and prints `FAIL` with the failed checks, and still
  destroys the VM. If cleanup itself fails it prints the VM id: delete that
  VM manually.
- Ctrl-C also destroys the VM before exiting.
- Do not rerun repeatedly in a loop; each run costs OpenAI and Superserve
  usage.
