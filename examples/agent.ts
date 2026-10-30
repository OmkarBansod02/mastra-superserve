/**
 * A Mastra agent, driven by an OpenAI model, completing a small desktop task on
 * a Superserve cloud VM: open a terminal, type a command that writes a file,
 * and confirm it. The model picks and calls every tool itself.
 *
 * Needs SUPERSERVE_API_KEY and OPENAI_API_KEY (read from .env by the npm script
 * via Node's --env-file-if-exists). MODEL is a Mastra router id for an OpenAI
 * model with tool calling and image input (default `openai/gpt-5.4-mini`).
 * Steps and wall time are capped and the VM is always destroyed at the end.
 *
 *   pnpm example:agent
 */
import { createDesktopAgent, createDesktopWorkspace, shellWritesTo } from './desktop-agent.js';

const MODEL = process.env.MODEL ?? 'openai/gpt-5.4-mini';
const MAX_STEPS = Math.min(Number(process.env.MAX_STEPS ?? 10), 15);
const RUN_TIMEOUT_MS = 5 * 60_000;

if (!MODEL.startsWith('openai/')) {
  console.error(`MODEL must be an OpenAI router id (openai/<model>), got ${JSON.stringify(MODEL)}.`);
  process.exit(1);
}
if (!process.env.SUPERSERVE_API_KEY || !process.env.OPENAI_API_KEY) {
  console.log('Skipping: set SUPERSERVE_API_KEY and OPENAI_API_KEY to run this example.');
  process.exit(0);
}

// Count the screenshots that actually go to OpenAI: the Responses API carries
// them as `input_image` parts inside `function_call_output` items. Only ids and
// sizes are recorded; request headers (the API key) are never touched.
const imagesSentToModel = new Map<string, number>();
const realFetch = globalThis.fetch;
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

const token = `mastra-openai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const target = '/tmp/mastra-agent-demo.txt';
const { sandbox, workspace } = createDesktopWorkspace({ namePrefix: 'mastra-openai-agent', timeoutSeconds: 600 });
const agent = createDesktopAgent(workspace, MODEL);

let destroyed: Promise<void> | undefined;
const destroy = () => (destroyed ??= workspace.destroy().then(() => console.log(`VM destroyed (status: ${sandbox.status})`)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void destroy().finally(() => process.exit(130)));
}
// Last-resort guard in case cleanup itself hangs.
setTimeout(() => {
  console.error('Watchdog: run exceeded its time budget, exiting.');
  void destroy().finally(() => process.exit(1));
}, RUN_TIMEOUT_MS + 120_000).unref();

type ToolChunk = { payload?: { toolName?: string; args?: unknown; result?: unknown; isError?: boolean } };

try {
  console.log(`model: ${MODEL}, max steps: ${MAX_STEPS}`);
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
  const typedToken = calls.some((c) => c.toolName?.endsWith('computer_type') && JSON.stringify(c.args).includes(token));
  const shellWrote = calls.some(
    (c) => c.toolName?.endsWith('execute_command') && shellWritesTo(String((c.args as { command?: unknown })?.command ?? ''), target),
  );

  const u = result.totalUsage;
  console.log(`usage: input ${u?.inputTokens ?? '?'} tokens, output ${u?.outputTokens ?? '?'}, total ${u?.totalTokens ?? '?'}`);
  console.log(`screenshots sent to OpenAI as input_image: ${imagesSentToModel.size}`);
  console.log(`agent answer: ${JSON.stringify(result.text.slice(0, 300))}`);

  // Independent check, outside the agent.
  const check = await sandbox.executeCommand('cat', [target]);
  const fileOk = check.exitCode === 0 && check.stdout.trim() === token;
  const ok = fileOk && typedToken && !shellWrote && imagesSentToModel.size > 0 && result.text.includes(token);
  console.log(`file: ${fileOk ? 'contains the token' : `unexpected ${JSON.stringify(check.stdout.trim() || check.stderr.trim())}`}`);
  console.log(`typed via desktop: ${typedToken}, wrote via shell: ${shellWrote}`);
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`Agent run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await destroy();
}
