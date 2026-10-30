/**
 * A Mastra agent completing a small desktop task on a Superserve cloud VM:
 * open a terminal, type a command that writes a file, and confirm it.
 *
 * Needs SUPERSERVE_API_KEY and a key for the model provider. The model is
 * MODEL (default `anthropic/claude-sonnet-5-5`, which reads ANTHROPIC_API_KEY).
 * The step budget is capped and the VM is always destroyed at the end.
 *
 *   ANTHROPIC_API_KEY=… pnpm example:agent
 */
import { createDesktopAgent, createDesktopWorkspace } from './desktop-agent.js';

const MODEL = process.env.MODEL ?? 'anthropic/claude-sonnet-5-5';
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 15);
const PROVIDER_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

const keyVar = PROVIDER_KEYS[MODEL.split('/')[0]!];
if (!process.env.SUPERSERVE_API_KEY || (keyVar && !process.env[keyVar])) {
  console.log(`Skipping: set SUPERSERVE_API_KEY${keyVar ? ` and ${keyVar}` : ''} to run this example with ${MODEL}.`);
  process.exit(0);
}

const token = `hello-from-mastra-${Date.now().toString(36)}`;
const target = '/tmp/agent-task.txt';
const { sandbox, workspace } = createDesktopWorkspace({ namePrefix: 'mastra-agent-example', timeoutSeconds: 600 });
const agent = createDesktopAgent(workspace, MODEL);

try {
  // Start a terminal for the agent; the task itself is done through the desktop.
  await sandbox.executeCommand('setsid xfce4-terminal --disable-server >/dev/null 2>&1 &', [], { env: { DISPLAY: ':1' } });

  const result = await agent.generate(
    `A terminal window is open on the desktop. Using only the computer tools (screenshot, click, type, press key), ` +
      `click into the terminal and run: echo ${token} > ${target}` +
      ` Then take a screenshot to confirm the command ran, and reply with "DONE".`,
    { maxSteps: MAX_STEPS },
  );

  const toolNames = result.toolResults.map((r) => (r as { payload?: { toolName?: string } }).payload?.toolName);
  const check = await sandbox.executeCommand('cat', [target]);
  const ok = check.exitCode === 0 && check.stdout.trim() === token;
  console.log(`steps: ${result.steps.length}, tool calls: ${toolNames.length} (${[...new Set(toolNames)].join(', ')})`);
  console.log(`agent answer: ${JSON.stringify(result.text.slice(0, 200))}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${target} ${ok ? 'contains the expected token' : `= ${JSON.stringify(check.stdout.trim())}`}`);
  process.exitCode = ok ? 0 : 1;
} finally {
  await workspace.destroy();
  console.log(`VM destroyed (sandbox status: ${sandbox.status})`);
}
