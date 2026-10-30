/**
 * A Mastra agent, driven by an OpenAI model, completing a small desktop task on
 * a Superserve cloud VM: open a terminal, type a command that writes a file,
 * and confirm it. The model picks and calls every tool itself.
 *
 * Environment (read from .env by the npm script via --env-file-if-exists):
 * - SUPERSERVE_API_KEY, OPENAI_API_KEY: required.
 * - OPENAI_MODEL: an OpenAI model with tool calling and image input, with or
 *   without the `openai/` router prefix. Default `gpt-5.4-mini`.
 * - MAX_STEPS: agent step budget, 1–15. Default 10.
 * - DEBUG_IMAGES=1: count and log the screenshots sent to OpenAI as
 *   `input_image` parts (call ids and sizes only).
 *
 * Steps and wall time are capped and the VM is always destroyed at the end.
 * Keys and live-viewer URLs are never printed.
 *
 *   pnpm example:agent
 */
import { createDesktopAgent, createDesktopWorkspace, shellWritesTo } from './desktop-agent.js';

const rawModel = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
const MODEL = rawModel.startsWith('openai/') ? rawModel : `openai/${rawModel}`;
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 10);
const DEBUG_IMAGES = process.env.DEBUG_IMAGES === '1' || process.env.DEBUG_IMAGES === 'true';
const RUN_TIMEOUT_MS = 5 * 60_000;
const VM_TIMEOUT_SECONDS = 600;

if (rawModel.includes('/') && !rawModel.startsWith('openai/')) {
  console.error(`OPENAI_MODEL must be an OpenAI model (e.g. gpt-5.4-mini), got ${JSON.stringify(rawModel)}.`);
  process.exit(1);
}
if (!Number.isInteger(MAX_STEPS) || MAX_STEPS < 1 || MAX_STEPS > 15) {
  console.error(`MAX_STEPS must be an integer from 1 to 15, got ${JSON.stringify(process.env.MAX_STEPS)}.`);
  process.exit(1);
}
const missing = ['SUPERSERVE_API_KEY', 'OPENAI_API_KEY'].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.log(`Skipping: set ${missing.join(' and ')} (see .env.example) to run this example.`);
  process.exit(0);
}

// Optional diagnostics: count the screenshots that actually go to OpenAI. The
// Responses API carries them as `input_image` parts inside
// `function_call_output` items. Only ids and sizes are recorded; request
// headers (the API key) are never touched.
const imagesSentToModel = new Map<string, number>();
const realFetch = globalThis.fetch;
if (DEBUG_IMAGES) {
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.openai.com/') && typeof init?.body === 'string') {
      for (const item of (JSON.parse(init.body) as { input?: unknown[] }).input ?? []) {
        const { type, call_id, output } = item as { type?: string; call_id?: string; output?: unknown };
        if (type !== 'function_call_output' || !Array.isArray(output)) continue;
        for (const part of output as { type?: string; image_url?: string }[]) {
          if (part.type === 'input_image' && part.image_url?.startsWith('data:image/png;base64,')) {
            imagesSentToModel.set(call_id!, part.image_url.length);
          }
        }
      }
    }
    return realFetch(input, init);
  };
}

const token = `mastra-openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const target = '/tmp/mastra-agent-demo.txt';
const { sandbox, workspace } = createDesktopWorkspace({
  namePrefix: 'mastra-openai-agent',
  timeoutSeconds: VM_TIMEOUT_SECONDS,
});
const agent = createDesktopAgent(workspace, MODEL);

let destroyed: Promise<void> | undefined;
const destroy = () =>
  (destroyed ??= (async () => {
    // The sandbox is lazy: 'pending' means no VM was ever created.
    if (sandbox.status === 'pending') {
      console.log('cleanup: no VM was created');
      return;
    }
    const { metadata } = await sandbox.getInfo();
    try {
      await workspace.destroy();
      console.log(`cleanup: VM destroyed (status: ${sandbox.status})`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`cleanup FAILED: ${error instanceof Error ? error.message : String(error)}`);
      console.error(
        `  Delete Superserve VM ${String(metadata?.sandboxId ?? '(unknown id)')} manually. ` +
          `Otherwise it auto-pauses after ${VM_TIMEOUT_SECONDS}s active and is auto-deleted 600s after pausing.`,
      );
    }
  })());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`\n${signal} received, cleaning up...`);
    void destroy().finally(() => process.exit(130));
  });
}
// Last-resort guard in case cleanup itself hangs.
setTimeout(() => {
  console.error('Watchdog: run exceeded its time budget, exiting.');
  void destroy().finally(() => process.exit(1));
}, RUN_TIMEOUT_MS + 120_000).unref();

type ToolChunk = { payload?: { toolName?: string; args?: unknown; result?: unknown; isError?: boolean } };

try {
  console.log(`model: ${MODEL}, max steps: ${MAX_STEPS}, time limit: ${RUN_TIMEOUT_MS / 60_000} min`);
  const result = await agent.generate(
    [
      'Task on the Linux desktop:',
      '1. Take a screenshot to see the desktop.',
      '2. Open a terminal using the desktop (for example the terminal icon in the bottom dock) and make sure it has focus.',
      `3. Using the keyboard tools, type exactly: echo ${token} > ${target}`,
      '   then press Enter.',
      `4. Verify with execute_command: cat ${target}`,
      'Do not create or modify the file with execute_command; it is only for checking.',
      'Finish with one line: "RESULT: <file contents>" or "FAILED: <reason>".',
    ].join('\n'),
    { maxSteps: MAX_STEPS, abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS) },
  );

  const calls = result.steps.flatMap((s) => s.toolResults as ToolChunk[]).map((c) => c.payload ?? {});
  console.log(`steps: ${result.steps.length}, tool calls: ${calls.length}`);
  calls.forEach((c, i) => {
    const name = c.toolName?.replace('mastra_workspace_', '');
    console.log(`  ${i + 1}. ${name} ${JSON.stringify(c.args)}${c.isError ? ` -> ERROR ${JSON.stringify(c.result)}` : ''}`);
  });
  const usedTool = (suffix: string) => calls.some((c) => c.toolName?.endsWith(suffix) && !c.isError);
  const typedToken = calls.some((c) => c.toolName?.endsWith('computer_type') && JSON.stringify(c.args).includes(token));
  const shellWrote = calls.some(
    (c) => c.toolName?.endsWith('execute_command') && shellWritesTo(String((c.args as { command?: unknown })?.command ?? ''), target),
  );

  const u = result.totalUsage;
  console.log(`usage: input ${u?.inputTokens ?? '?'} tokens, output ${u?.outputTokens ?? '?'}, total ${u?.totalTokens ?? '?'}`);
  if (DEBUG_IMAGES) {
    console.log(`screenshots sent to OpenAI as input_image: ${imagesSentToModel.size}`);
    for (const [id, size] of imagesSentToModel) console.log(`  ${id}: ${size} chars of base64 PNG`);
  }
  console.log(`agent answer: ${JSON.stringify(result.text.slice(0, 300))}`);

  // Independent check, outside the agent.
  const check = await sandbox.executeCommand('cat', [target]);
  const fileOk = check.exitCode === 0 && check.stdout.trim() === token;
  const checks: [string, boolean][] = [
    ['agent took a screenshot', usedTool('computer_screenshot')],
    ['agent typed the command via the keyboard tool', typedToken],
    ['agent did not write the file via the shell', !shellWrote],
    [`${target} contains the token (checked outside the agent)`, fileOk],
    ['agent reported the token', result.text.includes(token)],
    ...(DEBUG_IMAGES ? [['screenshots reached OpenAI as input_image', imagesSentToModel.size > 0] as [string, boolean]] : []),
  ];
  for (const [name, passed] of checks) console.log(`  [${passed ? 'ok' : 'FAIL'}] ${name}`);
  // Informational: the agent may open the terminal by keyboard instead.
  console.log(`  [info] agent used the mouse: ${usedTool('computer_click') || usedTool('computer_double_click')}`);
  if (!fileOk) console.log(`  file contents: ${JSON.stringify(check.stdout.trim() || check.stderr.trim())}`);
  const ok = checks.every(([, passed]) => passed);
  console.log(ok ? 'PASS: the agent completed the desktop task' : 'FAIL: see the failed checks above');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`FAIL: agent run errored: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await destroy();
}
