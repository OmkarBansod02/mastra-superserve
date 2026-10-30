/**
 * A minimal Mastra agent that drives a Superserve cloud desktop.
 *
 * The agent gets no hand-written tools: giving it a `Workspace` whose sandbox
 * has the `computer` capability is enough for Mastra to inject the
 * `mastra_workspace_computer_*` tools (plus `mastra_workspace_execute_command`).
 */
import { Agent } from '@mastra/core/agent';
import { Workspace, type WorkspaceToolsConfig } from '@mastra/core/workspace';
import { SuperserveSandbox, type SuperserveSandboxOptions } from '../src/index.js';

export const DESKTOP_AGENT_INSTRUCTIONS = [
  'You operate a Linux desktop through the computer tools.',
  'Take a screenshot before acting, act with as few steps as possible,',
  'and verify the result before you answer. Never touch anything outside the task.',
].join(' ');

/**
 * Whether a shell command writes `path` (redirect, tee, cp/mv/touch/install).
 * Used to check that a demo file was created through the desktop, not the
 * shell; reads such as `cat path` or unrelated pipes do not count.
 */
export function shellWritesTo(command: string, path: string): boolean {
  const target = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(>>?|\\btee\\b[^|;&]*|\\b(cp|mv|touch|install)\\b[^|;&]*)\\s*['"]?${target}(?![\\w./-])`).test(command);
}

export function createDesktopWorkspace(options: SuperserveSandboxOptions = {}, tools?: WorkspaceToolsConfig) {
  const sandbox = new SuperserveSandbox(options);
  const workspace = new Workspace({ sandbox, ...(tools && { tools }) });
  return { sandbox, workspace };
}

export function createDesktopAgent(workspace: Workspace, model: ConstructorParameters<typeof Agent>[0]['model']) {
  return new Agent({
    id: 'superserve-desktop-agent',
    name: 'Superserve desktop agent',
    instructions: DESKTOP_AGENT_INSTRUCTIONS,
    model,
    workspace,
  });
}
