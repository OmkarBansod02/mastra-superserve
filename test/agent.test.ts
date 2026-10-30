// The real Mastra agent loop (scripted model, mocked Superserve SDK) reaches the provider.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVm, type FakeVm } from './fakes.js';

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  killById: vi.fn(),
}));
vi.mock('@superserve/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@superserve/sdk')>();
  return { ...actual, Sandbox: sdk };
});

const { createDesktopAgent, createDesktopWorkspace, shellWritesTo } = await import('../examples/desktop-agent.js');
const { scriptedModel } = await import('../examples/scripted-model.js');

let vm: FakeVm;

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  vm = fakeVm('vm-agent');
  sdk.create.mockResolvedValue(vm);
  sdk.list.mockResolvedValue([]);
  sdk.killById.mockResolvedValue(undefined);
  vm.commands.run.mockImplementation(async (command: string) =>
    command.startsWith('xdotool getmouselocation')
      ? { stdout: 'X=10\nY=20\nSCREEN=0\nWINDOW=1\n', stderr: '', exitCode: 0, truncated: false }
      : { stdout: 'ok\n', stderr: '', exitCode: 0, truncated: false },
  );
});

describe('Mastra Agent → workspace computer tools → SuperserveSandbox', () => {
  it('executes scripted tool calls against the provider and feeds results back', async () => {
    const { workspace } = createDesktopWorkspace({}, { mastra_workspace_computer_click: { screenshotDelayMs: 0 } });
    const agent = createDesktopAgent(
      workspace,
      scriptedModel([
        { toolCalls: [{ toolName: 'mastra_workspace_computer_get_screen_info', input: {} }] },
        { toolCalls: [{ toolName: 'mastra_workspace_computer_click', input: { x: 100, y: 200 } }] },
        { toolCalls: [{ toolName: 'mastra_workspace_execute_command', input: { command: 'echo ok' } }] },
        { text: 'done' },
      ]),
    );

    const result = await agent.generate('click the desktop', { maxSteps: 5 });

    expect(result.text).toBe('done');
    expect(vm.desktop.click).toHaveBeenCalledWith(100, 200);
    expect(vm.commands.run).toHaveBeenCalledWith('echo ok', expect.anything());
    const outputs = result.toolResults.map((r: any) => JSON.stringify(r.payload?.result ?? r.result));
    expect(outputs.join('\n')).toContain('Screen size: 1280x800');
    expect(outputs.join('\n')).toContain('Cursor position: (10, 20)');
    expect(outputs.join('\n')).toContain('Clicked at (100, 200)');

    await workspace.destroy();
    expect(sdk.killById).toHaveBeenCalledWith('vm-agent', {});
  });

  it('rejects out-of-schema tool input before it reaches the provider', async () => {
    const { workspace } = createDesktopWorkspace();
    const agent = createDesktopAgent(
      workspace,
      scriptedModel([
        { toolCalls: [{ toolName: 'mastra_workspace_computer_click', input: { x: -5, y: 1.5 } }] },
        { text: 'gave up' },
      ]),
    );
    const result = await agent.generate('click', { maxSteps: 3 });
    const output = (result.toolResults[0] as any)?.payload?.result;
    expect(output?.message).toContain('Tool input validation failed for mastra_workspace_computer_click');
    expect(vm.desktop.click).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });
});

describe('shellWritesTo (demo check that a file was not created through the shell)', () => {
  const path = '/tmp/mastra-agent-demo.txt';

  it.each([
    `echo tok > ${path}`,
    `echo tok >>${path}`,
    `printf tok | tee -a ${path}`,
    `cp /tmp/x "${path}"`,
    `touch ${path}`,
  ])('flags %s', (command) => expect(shellWritesTo(command, path)).toBe(true));

  it.each([
    'echo $DISPLAY && ls /tmp | head', // the live run's false positive
    `cat ${path}`,
    `cat ${path} 2>/dev/null`,
    `echo tok > ${path}.bak`,
    `grep tok ${path} | wc -l`,
  ])('ignores %s', (command) => expect(shellWritesTo(command, path)).toBe(false));
});
