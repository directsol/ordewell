import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import { fakeFileSystem } from '../../testing';
import type { ResearchProgress } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import type { ConversationRequest } from '../AiService';

const createSpy = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createSpy } };
  },
}));

import { OpenAiService } from '../OpenAiService';

function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function cfg(over: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openai',
    orchestratorModel: 'openai:gpt-4o',
    getProviderBaseUrl: () => 'https://api.openai.com/v1',
    getProviderApiKey: () => 'sk-test',
    ...over,
  } as unknown as IConfig;
}

/** Invoke the protected streamPlanText and return the model sent to the API. */
async function modelSentFor(config: IConfig): Promise<string> {
  createSpy.mockReturnValue(streamOf([{ choices: [{ delta: { content: 'ok' } }] }]));
  const service = new OpenAiService(config);
  await (service as unknown as {
    streamPlanText(p: string, h: string | undefined, onToken: (t: string) => void): Promise<string>;
  }).streamPlanText('prompt', undefined, () => {});
  return (createSpy.mock.calls[0][0] as { model: string }).model;
}

describe('OpenAiService model-id prefix stripping', () => {
  beforeEach(() => createSpy.mockClear());

  it('strips the provider prefix before sending the model to the API', async () => {
    expect(await modelSentFor(cfg())).toBe('gpt-4o');
  });

  it('passes openai_compat: models through as the bare id', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openai_compatible',
      orchestratorModel: 'openai_compat:llama3',
    } as Partial<IConfig>));
    expect(model).toBe('llama3');
  });

  it('leaves an unprefixed OpenRouter id untouched', async () => {
    const model = await modelSentFor(cfg({
      aiProvider: 'openrouter',
      orchestratorModel: 'openai/gpt-4o',
    } as Partial<IConfig>));
    expect(model).toBe('openai/gpt-4o');
  });
});

describe('OpenAiService usage reporting (#49)', () => {
  beforeEach(() => createSpy.mockClear());

  function usageEvents(config: IConfig, chunks: unknown[], contextWindow?: number): Promise<UsageRecord[]> {
    createSpy.mockReturnValue(streamOf(chunks));
    const progress: ResearchProgress[] = [];
    const req: ConversationRequest = {
      goal: 'add a cache',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem(),
      onProgress: (p) => progress.push(p),
      ...(contextWindow ? { contextWindow } : {}),
    };
    return new OpenAiService(config).startConversation(req).then(() =>
      progress.filter((p) => p.type === 'usage').map((p) => p.record!),
    );
  }

  it('reports tokens, the cached share and the OpenRouter cost from the final chunk', async () => {
    const records = await usageEvents(
      cfg({ aiProvider: 'openrouter', orchestratorModel: 'openai/gpt-4o' } as Partial<IConfig>),
      [
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 80 }, cost: 0.0012 } },
      ],
    );

    expect(records).toEqual([
      {
        source: 'openrouter',
        model: 'openai/gpt-4o',
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 80,
        reportedCost: { amount: 0.0012, currency: 'USD' },
      },
    ]);
  });

  it('leaves cost and cached share absent when the provider reports neither', async () => {
    const records = await usageEvents(
      cfg(),
      [
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ],
    );

    expect(records).toEqual([{ source: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 2 }]);
    expect(records[0]).not.toHaveProperty('reportedCost');
    expect(records[0]).not.toHaveProperty('cachedInputTokens');
  });

  it('carries a known context window on the record and omits an unknown one', async () => {
    const withWindow = await usageEvents(
      cfg(),
      [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
      128000,
    );
    expect(withWindow[0].contextWindow).toBe(128000);

    const withoutWindow = await usageEvents(
      cfg(),
      [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
    );
    expect(withoutWindow[0]).not.toHaveProperty('contextWindow');
  });
});
