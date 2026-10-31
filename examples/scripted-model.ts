/**
 * A scripted stand-in for an LLM, for exercising the real Mastra agent loop
 * (tool conversion, schema validation, execution, result feedback) without a
 * model API key. Each step either calls tools or answers with text; both
 * `agent.generate()` and `agent.stream()` consume the same script.
 */
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

export type ScriptedStep =
  | { toolCalls: { toolName: string; input: Record<string, unknown> }[] }
  | { text: string };

type MockConfig = NonNullable<ConstructorParameters<typeof MastraLanguageModelV2Mock>[0]>;
type GenerateResult = Awaited<ReturnType<Extract<MockConfig['doGenerate'], (...args: any[]) => any>>>;
type StreamResult = Awaited<ReturnType<Extract<MockConfig['doStream'], (...args: any[]) => any>>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * `onPrompt` receives the prompt Mastra sends on each model call (tests use it
 * to check what context a model invocation was given).
 */
export function scriptedModel(steps: ScriptedStep[], opts: { onPrompt?: (prompt: unknown) => void } = {}) {
  let index = 0;
  const next = () => {
    const n = index++;
    // Past the end of the script, answer instead of looping forever.
    const step = steps[n] ?? { text: 'Script exhausted.' };
    const content =
      'toolCalls' in step
        ? step.toolCalls.map((call, i) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${n}-${i}`,
            toolName: call.toolName,
            input: JSON.stringify(call.input),
          }))
        : [{ type: 'text' as const, text: step.text }];
    const finishReason = 'toolCalls' in step ? ('tool-calls' as const) : ('stop' as const);
    return { n, content, finishReason };
  };

  return new MastraLanguageModelV2Mock({
    provider: 'scripted',
    modelId: 'scripted-desktop-model',
    doGenerate: async (options) => {
      opts.onPrompt?.(options.prompt);
      const { content, finishReason } = next();
      return { content, finishReason, usage, warnings: [] } as GenerateResult;
    },
    doStream: async (options) => {
      opts.onPrompt?.(options.prompt);
      const { n, content, finishReason } = next();
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      for (const c of content) {
        if (c.type === 'tool-call') parts.push(c);
        else parts.push({ type: 'text-start', id: `t${n}` }, { type: 'text-delta', id: `t${n}`, delta: c.text }, { type: 'text-end', id: `t${n}` });
      }
      parts.push({ type: 'finish', finishReason, usage });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}
