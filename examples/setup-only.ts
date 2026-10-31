/**
 * `DEMO_SETUP_ONLY=1 pnpm example:agent`: check the Mousepad setup on one
 * live VM, with no agent. Creates the VM, runs the read-only editor
 * preflight, `installMousepad` (install and verification in one streamed
 * command), then the preflight again as an independent check, and prints
 * `[SETUP] PASS` or the failure. The VM is always destroyed at the end.
 *
 * No Mastra agent is created and no OpenAI call is made (OPENAI_API_KEY is
 * not needed). No live viewer, no pause/reconnect.
 */
import type { SuperserveSandboxOptions } from '../src/index.js';
import { destroyAndConfirm, shortId, type Log } from './demo.js';
import { createDesktopWorkspace } from './desktop-agent.js';
import { describeError, EDITOR_SETUP_TIMEOUT_SECONDS, installMousepad, preflightEditorTask, retryReadOnlyOnce } from './editor-task.js';

/** Upper bound for the whole run, cleanup included. */
export const SETUP_ONLY_WATCHDOG_MS = (EDITOR_SETUP_TIMEOUT_SECONDS + 4 * 60) * 1000;

/** Returns the process exit code: 0 only if setup passed and the VM is confirmed deleted. */
export async function runSetupOnly(options: SuperserveSandboxOptions, log: Log = console.log): Promise<number> {
  const { sandbox, workspace } = createDesktopWorkspace(options);
  let phase = 'VM start';
  let ok = false;

  let cleaned: Promise<boolean> | undefined;
  const cleanup = () =>
    (cleaned ??= (async () => {
      if (sandbox.status === 'pending') {
        log('cleanup: no VM was created');
        return true;
      }
      const vmId = sandbox.sandboxId;
      try {
        if (vmId) {
          const status = await destroyAndConfirm([workspace], vmId, sandbox.id);
          if (status !== 'deleted' && status !== 'absent') throw new Error(`VM still ${status} after destroy`);
          log(`[VM] Destroyed (sandbox ${shortId(vmId)} no longer listed by Superserve)`);
        } else {
          await workspace.destroy();
          log(`cleanup: VM destroyed (status: ${sandbox.status})`);
        }
        return true;
      } catch (error) {
        log(`cleanup FAILED: ${describeError(error)}`);
        log(`  Delete Superserve VM ${vmId ?? '(unknown id)'} manually.`);
        return false;
      }
    })());

  const onSignal = (signal: NodeJS.Signals) => {
    log(`\n${signal} received, cleaning up...`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const watchdog = setTimeout(() => {
    log('Watchdog: setup-only run exceeded its time budget, exiting.');
    void cleanup().finally(() => process.exit(1));
  }, SETUP_ONLY_WATCHDOG_MS).unref();

  try {
    log('setup-only mode: no agent, no OpenAI calls');
    await sandbox.start();
    log(`[VM] Created (sandbox ${shortId(sandbox.sandboxId)})`);
    phase = 'editor preflight';
    const before = await retryReadOnlyOnce('preflight', () => preflightEditorTask(sandbox), log);
    log(`[ENV] Before setup: ${before.editor ? `${before.editor.name} (${before.editor.bin}) found` : 'no GUI text editor found'}`);
    // Installs even if Mousepad is present: apt-get is idempotent and this mode exists to exercise the install path.
    phase = 'editor setup';
    const setup = await installMousepad(sandbox, (line) => log(`[SETUP] ${line}`));
    if (!setup.ok) {
      log(`[SETUP] FAIL at ${setup.step} (${setup.failure}): ${setup.detail}`);
    } else {
      log(`[SETUP] ${setup.detail}`);
      phase = 'editor preflight after setup';
      const after = await retryReadOnlyOnce('preflight', () => preflightEditorTask(sandbox), (line) => log(`[SETUP] ${line}`));
      if (after.editor?.bin === 'mousepad') {
        ok = true;
        log('[SETUP] PASS: Mousepad and its menu entry are installed (confirmed again by a separate read-only check)');
      } else {
        log(`[SETUP] FAIL: the separate read-only check found ${after.editor ? after.editor.bin : 'no editor'}, not mousepad`);
      }
    }
  } catch (error) {
    log(`[SETUP] FAIL during ${phase}: ${describeError(error)}`);
  } finally {
    clearTimeout(watchdog);
    if (!(await cleanup())) ok = false;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  log(`[RESULT] ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}
