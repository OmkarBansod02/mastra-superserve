/**
 * Child-process fixture for the viewer-wait regression tests (test/demo.test.ts).
 * Mirrors examples/agent.ts: top-level await on the viewer wait inside
 * try/finally, cleanup in `finally`, and a `beforeExit` safety net. Nothing
 * else holds the event loop, as in the live run.
 *
 *   node --import tsx test/fixtures/viewer-wait.ts <fixed|unref> <waitMs>
 *
 * `fixed` uses waitForViewer; `unref` reproduces the old Promise.race with an
 * unref'd timer (Node exits with code 13 and `finally` never runs).
 */
import { startViewerRedirect, waitForViewer } from '../../examples/demo.js';

const [mode, waitMs] = [process.argv[2], Number(process.argv[3])];
const viewer = await startViewerRedirect(async () => 'https://viewer.invalid/vnc.html', 0);
let cleaned: Promise<void> | undefined;
const cleanup = (why: string) =>
  (cleaned ??= viewer.close().then(() => console.log(`cleanup: ${why}`)));
process.once('beforeExit', () => {
  if (!cleaned) {
    process.exitCode = 1;
    void cleanup('beforeExit');
  }
});

console.log(`url: ${viewer.localUrl}`);
try {
  const opened =
    mode === 'unref'
      ? await Promise.race([
          viewer.opened.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), waitMs).unref()),
        ])
      : await waitForViewer(viewer, waitMs);
  if (!opened) throw new Error('viewer not opened');
  console.log('opened');
} catch (error) {
  console.log(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await cleanup('finally');
}
