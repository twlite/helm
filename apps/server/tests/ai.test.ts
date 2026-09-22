import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { asSchema, embed, type EmbeddingModel } from 'ai';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { AgentTurnContext, EnvironmentObservation, TaskDefinition } from '@helm/shared';

import { createTaskState } from '../src/agent/task-state';
import type { AgentRuntimeResult } from '../src/agent/types';
import {
  BROWSER_RESEARCH_CRITERION_ID,
  browserResearchStartUrl,
  isBrowserResearchRequest,
  isSearchEngineUrl,
  isSearchResultsUrl,
  isUnsupportedSearchEngineUrl,
} from '../src/agent/browser-research';
import {
  AiSdkDecisionProvider,
  AiSdkEmbeddingProvider,
  AiSdkMemoryExtractor,
  AiSdkOrchestrator,
  AiSdkResponseGenerator,
  AiSdkTaskPlanner,
  AiSdkThreadTitleGenerator,
  AiSdkWorker,
  aiTaskPlanSchema,
  aiDecisionSchema,
} from '../src/ai/adapter';
import { adaptStructuredOutputJsonSchema } from '../src/ai/structured-output';

function fakeEmbeddingModel(values: number[]): EmbeddingModel {
  return {
    specificationVersion: 'v4',
    provider: 'test.embedding',
    modelId: 'test-embedding',
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: false,
    doEmbed: async ({ values: inputs }: { values: string[] }) => ({
      embeddings: inputs.map(() => values),
      warnings: [],
    }),
  } as unknown as EmbeddingModel;
}

describe('LM Studio AI adapters', () => {
  it('extracts durable user context while preserving corrected URLs', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-memory',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              remember: true,
              content: 'For Nepal Rastra Bank forex requests, use https://www.nrb.org.np/forex/.',
              kind: 'instruction',
              importance: 0.95,
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const extractor = new AiSdkMemoryExtractor({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    await expect(extractor.extract({
      userMessage: 'Oops, remember the correct Nepal Rastra Bank URL for future requests.',
    })).resolves.toEqual({
      content: 'For Nepal Rastra Bank forex requests, use https://www.nrb.org.np/forex/.',
      kind: 'instruction',
      importance: 0.95,
    });
  });

  it('keeps arbitrary action input keys while adapting the MLX schema', async () => {
    const nativeSchema = await asSchema(aiDecisionSchema).jsonSchema;
    const compatibleSchema = adaptStructuredOutputJsonSchema(nativeSchema, 'lmstudio-mlx');
    const actionBranch = (compatibleSchema.oneOf as Array<Record<string, unknown>>).find(branch => (
      ((branch.properties as Record<string, unknown>).type as Record<string, unknown>).const === 'action'
    ));
    const actionInput = (actionBranch?.properties as Record<string, unknown>).input;

    expect(actionInput).toEqual({ type: 'object', additionalProperties: {} });
    expect(compatibleSchema.oneOf).toHaveLength(3);
    expect(actionBranch).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(compatibleSchema)).not.toContain('propertyNames');

    const parsed = aiDecisionSchema.safeParse({
      type: 'action',
      tool: 'some_tool',
      input: { foo: 'bar', nested: { anything: true } },
    });
    expect(parsed.success).toBe(true);
  });

  it('preserves the native schema object for providers without compatibility requirements', async () => {
    const nativeSchema = await asSchema(aiDecisionSchema).jsonSchema;

    expect(adaptStructuredOutputJsonSchema(nativeSchema, 'native')).toBe(nativeSchema);
    expect(JSON.stringify(nativeSchema)).toContain('propertyNames');
  });

  it('keeps all decision variants valid and rejects invalid top-level shapes', () => {
    expect(aiDecisionSchema.safeParse({ type: 'complete' }).success).toBe(true);
    expect(aiDecisionSchema.safeParse({ type: 'blocked', reason: 'Needs attention' }).success).toBe(true);
    expect(aiDecisionSchema.safeParse({ type: 'unexpected' }).success).toBe(false);
    expect(aiDecisionSchema.safeParse({ type: 'action', tool: 'some_tool' }).success).toBe(false);
  });

  it('sends the MLX-compatible schema to the model without weakening native validation', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-decision',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'action',
                tool: 'some_tool',
                input: { foo: 'bar', nested: { anything: true } },
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const decisionProvider = new AiSdkDecisionProvider({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [],
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const context: AgentTurnContext = {
      task: {
        id: 'task-1',
        threadId: 'thread-1',
        goal: 'Do a thing',
        criteria: [{ type: 'file.exists', path: 'note.txt' }],
      },
      observation: {
        timestamp: 1,
        task: { completedCriteria: [], remainingCriteria: ['File exists: note.txt'] },
      },
      history: [],
      memories: [],
      stepIndex: 0,
      previousResults: [],
    };

    await expect(decisionProvider.next(context)).resolves.toMatchObject({
      type: 'action',
      tool: 'some_tool',
    });

    const responseFormat = requestBody?.response_format as Record<string, unknown>;
    const modelSchema = ((responseFormat?.json_schema as Record<string, unknown>)?.schema) as Record<string, unknown>;
    expect(JSON.stringify(modelSchema)).not.toContain('propertyNames');
    expect(modelSchema.oneOf).toHaveLength(3);
  });

  it('starts browser research when the decision model refuses before using the browser', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-research-decision',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'blocked',
              reason: 'I cannot access current financial data.',
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const decisionProvider = new AiSdkDecisionProvider({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [],
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const context: AgentTurnContext = {
      task: {
        id: 'research-task',
        threadId: 'thread-research',
        goal: 'Use the browser to research current public information.',
        criteria: [{
          type: 'custom',
          id: BROWSER_RESEARCH_CRITERION_ID,
          description: 'Read current public web information with the browser before answering.',
        }],
      },
      observation: {
        timestamp: 1,
        task: { completedCriteria: [], remainingCriteria: ['browser research'] },
      },
      history: [],
      memories: [{
        id: 'memory-nrb-source',
        content: 'User correction to remember: for the Nepal Rastra Bank exchange rate, use https://www.nrb.org.np/forex/.',
        kind: 'instruction',
        importance: 0.95,
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
      conversation: [{
        id: 'message-research',
        threadId: 'thread-research',
        role: 'user',
        content: 'Find the Nepali exchange rate defined by Nepal Rastra Bank today.',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      stepIndex: 0,
      previousResults: [],
    };

    await expect(decisionProvider.next(context)).resolves.toMatchObject({
      type: 'action',
      tool: 'browser.navigate',
      input: { url: 'https://www.nrb.org.np/forex/' },
    });
  });

  it('plans ordinary conversation without inventing a browser criterion', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-plan',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ mode: 'conversation', goal: 'Answer the user directly.', criteria: [] }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    await expect(planner.createTask({
      threadId: 'thread-chat',
      userMessage: 'Please answer this question about Helm: who are you?',
      conversation: [{
        id: 'message-1',
        threadId: 'thread-chat',
        role: 'user',
        content: 'Who are you?',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })).resolves.toMatchObject({ criteria: [], goal: 'Answer the user directly.' });

    expect(aiTaskPlanSchema.safeParse({ mode: 'conversation', goal: 'Answer directly.', criteria: [] }).success).toBe(true);
    expect(JSON.stringify(requestBody)).toContain('Who are you?');
  });

  it('keeps model guesses out of compiled acceptance criteria', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-plan-guard',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              mode: 'conversation',
              goal: 'Open a page and write a result file.',
              criteria: [
                { type: 'browser.url', url: 'https://invented.example/releases' },
                { type: 'file.contains', path: '~/Desktop/result.txt', expected: 'invented content' },
              ],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    const task = await planner.createTask({
      threadId: 'thread-plan-guard',
      userMessage: 'Open example.com and write ~/Desktop/result.txt.',
    });

    expect(task.isConversation).toBe(false);
    expect(task.criteria).toEqual([]);
    expect(task.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'browser', target: { url: 'https://example.com' } }),
      expect.objectContaining({ type: 'filesystem', target: expect.objectContaining({ path: '~/Desktop/result.txt' }) }),
    ]));
    expect(JSON.stringify(task)).not.toContain('invented.example');
    expect(JSON.stringify(task)).not.toContain('invented content');
  });

  it('routes current public web questions to browser research instead of accepting a conversational refusal', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-research-plan',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                mode: 'conversation',
                goal: 'I cannot access live financial data.',
                criteria: [],
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const userMessage = 'Find the Nepali exchange rate defined by Nepal Rastra Bank today.';

    expect(isBrowserResearchRequest(userMessage)).toBe(true);
    expect(isBrowserResearchRequest("What's today's exchange rate?")).toBe(true);
    expect(isBrowserResearchRequest('Who are you?')).toBe(false);
    expect(browserResearchStartUrl('nrb.org.np')).toBe('https://nrb.org.np');
    await expect(planner.createTask({
      threadId: 'thread-research',
      userMessage,
    })).resolves.toMatchObject({
      goal: expect.stringContaining("Use Helm's browser"),
      criteria: [{
        type: 'custom',
        id: BROWSER_RESEARCH_CRITERION_ID,
      }],
    });
    expect(JSON.stringify(requestBody)).toContain('current or publicly available web information are tasks, not conversation');
    expect(JSON.stringify(requestBody)).toContain('browser.extractText');
  });

  it('allows DuckDuckGo as the only search engine and rewrites Google or Bing searches', () => {
    const duckDuckGoUrl = 'https://duckduckgo.com/?q=latest%20bun%20release';
    const googleUrl = 'https://www.google.com/search?q=latest+bun+release';
    const bingUrl = 'https://www.bing.com/search?q=latest+bun+release';

    expect(browserResearchStartUrl('latest bun release')).toBe(duckDuckGoUrl);
    expect(browserResearchStartUrl(googleUrl)).toBe(duckDuckGoUrl);
    expect(browserResearchStartUrl(bingUrl)).toBe(duckDuckGoUrl);
    expect(browserResearchStartUrl('www.google.com/search?q=latest+bun+release')).toBe(duckDuckGoUrl);
    expect(browserResearchStartUrl('https://www.google.com')).toBe('https://duckduckgo.com');
    expect(browserResearchStartUrl('twlite.txt')).toBe('https://duckduckgo.com/?q=twlite.txt');
    expect(browserResearchStartUrl('twlite.html')).toBe('https://duckduckgo.com/?q=twlite.html');
    expect(browserResearchStartUrl('file:///home/helm/release.html')).toBe('file:///home/helm/release.html');
    expect(browserResearchStartUrl('about:blank')).toBe('about:blank');
    expect(isSearchEngineUrl(duckDuckGoUrl)).toBe(true);
    expect(isSearchResultsUrl(duckDuckGoUrl)).toBe(true);
    expect(isSearchEngineUrl(googleUrl)).toBe(false);
    expect(isSearchResultsUrl(googleUrl)).toBe(false);
    expect(isUnsupportedSearchEngineUrl(googleUrl)).toBe(true);
    expect(isUnsupportedSearchEngineUrl(bingUrl)).toBe(true);
  });

  it('marks explicit search-engine research as requiring page content', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-search-plan',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                mode: 'task',
                goal: 'Search DuckDuckGo and inspect relevant project pages.',
                criteria: [{ type: 'browser.url', url: 'https://duckduckgo.com/?q=Neplex+Technologies' }],
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const userMessage = 'See what projects Neplex Technologies makes. Use DuckDuckGo and look for them.';

    expect(isBrowserResearchRequest(userMessage)).toBe(true);
    const task = await planner.createTask({ threadId: 'thread-search', userMessage });

    expect(task.criteria).toContainEqual({
      type: 'custom',
      id: BROWSER_RESEARCH_CRITERION_ID,
      description: 'Read current public web information with the browser before answering.',
    });
    expect(JSON.stringify(requestBody)).toContain('open a relevant result site');
  });

  it('compiles the GitHub release workflow into executable research and Desktop requirements', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-bun-release-plan',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              mode: 'task',
              goal: 'Research the requested GitHub release and write the result file.',
              criteria: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const userMessage = 'Open GitHub and go to the oven-sh/bun repository. Find the latest release version and its release date. Then create a folder called helm-demo on the Desktop and write a bun-release.md file containing the repository name, latest version, release date, release URL, and the current date.';
    const task = await planner.createTask({ threadId: 'bun-release-plan', userMessage });
    const requirements = task.requirements ?? [];

    expect(requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browserResearch', target: { factId: 'pageContent' } }),
      expect.objectContaining({ id: 'latestReleaseVersion', target: { factId: 'latestReleaseVersion' } }),
      expect.objectContaining({ id: 'releaseDate', target: { factId: 'releaseDate' } }),
      expect.objectContaining({ id: 'releaseUrl', target: { factId: 'releaseUrl' } }),
      expect.objectContaining({ id: 'outputDirectory', target: { path: '~/Desktop/helm-demo', mode: 'exists' } }),
      expect.objectContaining({ id: 'outputFile', target: expect.objectContaining({ path: '~/Desktop/helm-demo/bun-release.md', mode: 'contains-facts' }) }),
    ]));
    expect(requirements.find(requirement => requirement.id === 'outputFile')?.target?.factIds).toEqual(expect.arrayContaining([
      'repositoryName', 'latestReleaseVersion', 'releaseDate', 'releaseUrl', 'currentDate',
    ]));
    expect(requirements.find(requirement => requirement.id === 'outputFile')?.target?.factIds).not.toContain('pageContent');
    expect(browserResearchStartUrl(userMessage)).toBe('https://github.com/oven-sh/bun');
    expect(requirements.findIndex(requirement => requirement.id === 'browserResearch')).toBeLessThan(
      requirements.findIndex(requirement => requirement.id === 'latestReleaseVersion'),
    );
  });

  it('keeps an explicitly supplied profile image URL as an asset instead of a browser destination', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-profile-image-plan',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              mode: 'task',
              goal: 'Research the GitHub profile and create the portfolio.',
              criteria: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const task = await planner.createTask({
      threadId: 'profile-image-plan',
      userMessage: 'Go to github.com/twlite and find out how many followers he has and his pinned repos with their details. Using that information, create twlite.html with a good looking portfolio website for Twilight. Use this as the profile picture image url: https://github.com/twlite.png',
    });

    const destinations = (task.requirements ?? [])
      .filter(requirement => requirement.type === 'browser')
      .map(requirement => requirement.target?.url);
    expect(destinations).toContain('https://github.com/twlite');
    expect(destinations).not.toContain('https://github.com/twlite.png');
    expect(task.constraints).toContainEqual(expect.objectContaining({
      description: expect.stringContaining('https://github.com/twlite.png'),
      source: 'user',
    }));
  });

  it('keeps output filenames out of compiled browser destinations', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-output-name-plan',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ mode: 'task', goal: 'Research the profile and save the result.', criteria: [] }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    for (const [index, fileName] of ['twlite.txt', 'twlite.html'].entries()) {
      const task = await planner.createTask({
        threadId: `output-name-${index}`,
        userMessage: `go to github.com/twlite and extract the profile details, then save them in ${fileName} file`,
      });
      const destinations = (task.requirements ?? [])
        .filter(requirement => requirement.type === 'browser')
        .map(requirement => requirement.target?.url);
      expect(destinations).toEqual(['https://github.com/twlite']);
      expect(task.requirements).toContainEqual(expect.objectContaining({
        id: 'outputFile',
        target: expect.objectContaining({ path: fileName }),
      }));
    }
  });

  it('blocks a worker from navigating to a user-provided asset URL', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-asset-navigation',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'action',
              tool: 'browser.navigate',
              input: { url: 'https://github.com/twlite.png' },
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const task: TaskDefinition = {
      id: 'asset-navigation-task',
      threadId: 'asset-navigation-thread',
      goal: 'Research the profile and use the supplied profile image URL.',
      originalRequest: 'Go to github.com/twlite and use https://github.com/twlite.png as the profile picture image URL.',
      criteria: [],
      requirements: [{
        id: 'browserDestination1',
        description: 'Reach the profile.',
        type: 'browser',
        mandatory: true,
        target: { url: 'https://github.com/twlite' },
      }],
      constraints: [],
    };
    const worker = new AiSdkWorker({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [{ name: 'browser.navigate', description: 'Navigate.', inputSchema: z.object({}) }],
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    let executeCount = 0;
    const result = await worker.execute({
      objective: {
        id: 'objective-browserDestination1-0',
        kind: 'browser',
        description: 'Reach the profile.',
        requirementIds: ['browserDestination1'],
        rationale: 'test',
      },
      task,
      state: createTaskState(task),
      observation: {
        timestamp: 1,
        browser: { url: 'https://github.com/twlite', loaded: true },
        task: { completedCriteria: [], remainingCriteria: ['browserDestination1'] },
      },
      verification: { complete: false, criteria: [], requirements: [], summary: '0/1 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 1,
      execute: {
        execute: async () => {
          executeCount += 1;
          return { ok: true };
        },
        observe: async () => ({
          timestamp: 1,
          browser: { url: 'https://github.com/twlite', loaded: true },
          task: { completedCriteria: [], remainingCriteria: ['browserDestination1'] },
        }),
      },
    });

    expect(executeCount).toBe(0);
    expect(result.status).toBe('blocked');
    expect(result.blockers[0]?.code).toBe('USER_ASSET_URL_NOT_NAVIGATION');
  });

  it('blocks a worker from navigating to a compiled output path', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-output-navigation',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'action',
              tool: 'browser.navigate',
              input: { url: 'https://twlite.html' },
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const task: TaskDefinition = {
      id: 'output-navigation-task',
      threadId: 'output-navigation-thread',
      goal: 'Research the profile and write the requested portfolio.',
      originalRequest: 'Go to github.com/twlite and create twlite.html.',
      criteria: [],
      requirements: [
        {
          id: 'browserDestination1',
          description: 'Reach the profile.',
          type: 'browser',
          mandatory: true,
          target: { url: 'https://github.com/twlite' },
        },
        {
          id: 'outputFile',
          description: 'Create the portfolio file.',
          type: 'filesystem',
          mandatory: true,
          target: { path: 'twlite.html', mode: 'exists' },
        },
      ],
      constraints: [],
    };
    const worker = new AiSdkWorker({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [{ name: 'browser.navigate', description: 'Navigate.', inputSchema: z.object({}) }],
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    let executeCount = 0;
    const result = await worker.execute({
      objective: {
        id: 'objective-profile-facts-0',
        kind: 'browser',
        description: 'Collect profile facts.',
        requirementIds: ['profileFacts'],
        rationale: 'test',
      },
      task,
      state: createTaskState(task),
      observation: {
        timestamp: 1,
        browser: { url: 'https://github.com/twlite', loaded: true },
        task: { completedCriteria: [], remainingCriteria: ['profileFacts'] },
      },
      verification: { complete: false, criteria: [], requirements: [], summary: '0/2 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 1,
      execute: {
        execute: async () => {
          executeCount += 1;
          return { ok: true };
        },
        observe: async () => ({
          timestamp: 1,
          browser: { url: 'https://github.com/twlite', loaded: true },
          task: { completedCriteria: [], remainingCriteria: ['profileFacts'] },
        }),
      },
    });

    expect(executeCount).toBe(0);
    expect(result.status).toBe('blocked');
    expect(result.blockers[0]?.code).toBe('OUTPUT_PATH_NOT_NAVIGATION');
  });

  it('compiles a page-to-file request and a later text-viewer request from the conversation', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-page-to-file-plan',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              mode: 'task',
              goal: 'Complete the requested file operation.',
              criteria: [],
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const firstRequest = 'go to https://twlite.dev and save the contents in a twlite.txt file';
    const firstTask = await planner.createTask({ threadId: 'page-to-file-thread', userMessage: firstRequest });
    expect(firstTask.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browserResearch', target: { factId: 'pageContent' } }),
      expect.objectContaining({
        id: 'outputFile',
        target: { path: 'twlite.txt', mode: 'contains-facts', factIds: ['pageContent'] },
      }),
    ]));

    const combinedTask = await planner.createTask({
      threadId: 'combined-page-to-file-thread',
      userMessage: 'go to https://twlite.dev and save the content in a twlite.md file and open it via text viewer app',
    });
    expect(combinedTask.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'outputFile',
        target: { path: 'twlite.md', mode: 'contains-facts', factIds: ['pageContent'] },
      }),
      expect.objectContaining({
        id: 'openFile',
        target: { path: 'twlite.md', content: 'twlite.md' },
      }),
    ]));

    const followUp = await planner.createTask({
      threadId: 'page-to-file-thread',
      userMessage: 'show me that text file using text viewer',
      conversation: [
        {
          id: 'message-page-to-file-request',
          threadId: 'page-to-file-thread',
          role: 'user',
          content: firstRequest,
          metadata: {},
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'message-page-to-file-result',
          threadId: 'page-to-file-thread',
          role: 'assistant',
          content: 'Saved twlite.txt.',
          metadata: {},
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
    expect(followUp.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openFile',
        type: 'desktop',
        target: { path: 'twlite.txt', content: 'twlite.txt' },
      }),
    ]));
  });

  it('forces a browserResearch worker to extract content instead of accepting done', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-browser-worker-done',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ type: 'done', reasoningSummary: 'The page is open.' }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const task: TaskDefinition = {
      id: 'browser-worker-task',
      threadId: 'browser-worker-thread',
      goal: 'Read the page.',
      originalRequest: 'Go to https://twlite.dev and read the page.',
      criteria: [],
      requirements: [
        { id: 'browserDestination', description: 'Reach the page.', type: 'browser', mandatory: true, target: { url: 'https://twlite.dev' } },
        { id: 'browserResearch', description: 'Collect readable page content.', type: 'fact', mandatory: true, target: { factId: 'pageContent' } },
      ],
      constraints: [],
    };
    const state = createTaskState(task);
    const observation: EnvironmentObservation = {
      timestamp: 1,
      browser: { url: 'https://twlite.dev', loaded: true },
      task: { completedCriteria: ['browserDestination'], remainingCriteria: ['browserResearch'] },
    };
    const executed: string[] = [];
    const worker = new AiSdkWorker({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [{
        name: 'browser.extractText',
        description: 'Extract page text.',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      }],
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    const result = await worker.execute({
      objective: {
        id: 'objective-browserResearch-0',
        kind: 'browser',
        description: 'Collect readable page content.',
        requirementIds: ['browserResearch'],
        rationale: 'test',
      },
      task,
      state,
      observation,
      verification: { complete: false, criteria: [], requirements: [], summary: '0/2 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 2,
      execute: {
        execute: async tool => {
          executed.push(tool);
          return {
            ok: true,
            data: { url: 'https://twlite.dev', title: 'Twilight', text: 'Helm makes local computer use useful.' },
            evidence: { receipt: { id: 'receipt-browser-extract' } },
          };
        },
        observe: async () => observation,
      },
    });

    expect(executed).toEqual(['browser.extractText']);
    expect(result.actions[0]?.tool).toBe('browser.extractText');
    expect(result.status).toBe('completed');
  });

  it('continues from a redirect target instead of navigating the source URL again', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-redirect-worker-done',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ type: 'done', reasoningSummary: 'The page is open.' }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 },
      }),
    });
    const sourceUrl = 'https://github.com/twlite.png';
    const finalUrl = 'https://avatars.githubusercontent.com/u/123456?v=4';
    const task: TaskDefinition = {
      id: 'redirect-worker-task',
      threadId: 'redirect-worker-thread',
      goal: 'Read the redirected page.',
      originalRequest: `Go to ${sourceUrl} and read the page.`,
      criteria: [],
      requirements: [
        { id: 'browserDestination', description: 'Reach the requested page.', type: 'browser', mandatory: true, target: { url: sourceUrl } },
        { id: 'browserResearch', description: 'Collect readable page content.', type: 'fact', mandatory: true, target: { factId: 'pageContent' } },
      ],
      constraints: [],
    };
    const worker = new AiSdkWorker({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [
        { name: 'browser.navigate', description: 'Navigate the browser.', inputSchema: z.object({}) },
        { name: 'browser.extractText', description: 'Extract page text.', inputSchema: z.object({}) },
      ],
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    let currentUrl = 'about:blank';
    const executed: string[] = [];
    const result = await worker.execute({
      objective: {
        id: 'objective-redirect-browserResearch-0',
        kind: 'browser',
        description: 'Collect readable page content.',
        requirementIds: ['browserResearch'],
        rationale: 'test',
      },
      task,
      state: createTaskState(task),
      observation: {
        timestamp: 1,
        browser: { url: currentUrl, loaded: true },
        task: { completedCriteria: [], remainingCriteria: ['browserDestination', 'browserResearch'] },
      },
      verification: { complete: false, criteria: [], requirements: [], summary: '0/2 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 3,
      execute: {
        execute: async tool => {
          executed.push(tool);
          if (tool === 'browser.navigate') currentUrl = finalUrl;
          return {
            ok: true,
            data: tool === 'browser.extractText'
              ? { url: finalUrl, title: 'Profile', text: 'Redirected profile page content.' }
              : { url: finalUrl, title: 'Profile', loaded: true },
            evidence: { receipt: { id: `receipt-${executed.length}` } },
          };
        },
        observe: async () => ({
          timestamp: Date.now(),
          browser: { url: currentUrl, loaded: true },
          task: { completedCriteria: [], remainingCriteria: ['browserDestination', 'browserResearch'] },
        }),
      },
    });

    expect(executed).toEqual(['browser.navigate', 'browser.extractText']);
    expect(result.actions.map(action => action.tool)).toEqual(executed);
    expect(result.status).toBe('completed');
  });

  it('forces page-to-file workers to write the observed fact and open the viewer', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-page-file-worker-done',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ type: 'done', reasoningSummary: 'The requested operation is complete.' }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const task: TaskDefinition = {
      id: 'page-file-worker-task',
      threadId: 'page-file-worker-thread',
      goal: 'Save the observed page and open it.',
      originalRequest: 'Go to https://twlite.dev, save the content in twlite.md, and open it in the text viewer.',
      criteria: [],
      requirements: [
        { id: 'outputFile', description: 'Write the observed page content.', type: 'filesystem', mandatory: true, target: { path: 'twlite.md', mode: 'contains-facts', factIds: ['pageContent'] } },
        { id: 'openFile', description: 'Open the file in the text viewer.', type: 'desktop', mandatory: true, target: { path: 'twlite.md', content: 'twlite.md' } },
      ],
      constraints: [],
    };
    const state = createTaskState(task);
    state.facts.push({
      id: 'pageContent',
      value: 'Observed page content.',
      origin: 'observed',
      confidence: 'observed',
      evidenceIds: ['receipt-browser-extract'],
      observedAt: new Date().toISOString(),
    });
    const baseObservation: EnvironmentObservation = {
      timestamp: 1,
      desktop: { windows: [] },
      task: { completedCriteria: [], remainingCriteria: ['outputFile', 'openFile'] },
    };
    const worker = new AiSdkWorker({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [
        { name: 'fs.write', description: 'Write a file.', inputSchema: z.object({}), execute: async () => ({}) },
        { name: 'app.openFile', description: 'Open a file.', inputSchema: z.object({}), execute: async () => ({}) },
      ],
      maxOutputTokens: 256,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const writeTools: string[] = [];
    const writeResult = await worker.execute({
      objective: { id: 'objective-outputFile-0', kind: 'filesystem', description: 'Write the observed page content.', requirementIds: ['outputFile'], rationale: 'test' },
      task,
      state,
      observation: baseObservation,
      verification: { complete: false, criteria: [], requirements: [], summary: '0/2 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 2,
      execute: {
        execute: async tool => {
          writeTools.push(tool);
          return { ok: true, data: { path: 'twlite.md', size: 23 }, evidence: { receipt: { id: 'receipt-write' } } };
        },
        observe: async () => baseObservation,
      },
    });
    expect(writeTools).toEqual(['fs.write']);
    expect(writeResult.status).toBe('completed');

    const openTools: string[] = [];
    const openResult = await worker.execute({
      objective: { id: 'objective-openFile-0', kind: 'desktop', description: 'Open the file in the text viewer.', requirementIds: ['openFile'], rationale: 'test' },
      task,
      state,
      observation: baseObservation,
      verification: { complete: false, criteria: [], requirements: [], summary: '0/2 requirements passed.' },
      memories: [],
      recentActions: [],
      failedStrategies: [],
      maxActions: 2,
      execute: {
        execute: async tool => {
          openTools.push(tool);
          return { ok: true, data: { path: 'twlite.md', application: 'text-editor', title: 'twlite.md - Text Editor' }, evidence: { receipt: { id: 'receipt-open' } } };
        },
        observe: async () => ({
          ...baseObservation,
          desktop: { windows: [{ id: 'text-editor', title: 'twlite.md - Text Editor', focused: true }] },
        }),
      },
    });
    expect(openTools).toEqual(['app.openFile']);
    expect(openResult.status).toBe('completed');
  });

  it('turns a procedural browserResearch blocker into the next orchestrator objective', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-orchestrator-blocker',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              type: 'blocked',
              reason: 'Cannot proceed without completing the browserResearch requirement. Need to perform web research first.',
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const orchestrator = new AiSdkOrchestrator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const task: TaskDefinition = {
      id: 'orchestrator-blocker-task',
      threadId: 'orchestrator-blocker-thread',
      goal: 'Research a public GitHub release.',
      originalRequest: 'Find the latest release on GitHub.',
      criteria: [],
      requirements: [{
        id: 'browserResearch',
        description: 'Collect readable evidence from the relevant public web page.',
        type: 'fact',
        mandatory: true,
        target: { factId: 'pageContent' },
      }],
    };
    const observation: EnvironmentObservation = {
      timestamp: 1,
      task: { completedCriteria: [], remainingCriteria: ['browserResearch'] },
    };
    const result = await orchestrator.next({
      task,
      state: createTaskState(task),
      observation,
      verification: { complete: false, criteria: [], requirements: [], summary: '0/1 requirements passed.' },
      memories: [],
      stepIndex: 0,
    });

    expect(result).toMatchObject({
      type: 'objective',
      objective: { kind: 'browser', requirementIds: ['browserResearch'] },
    });
  });

  it('keeps the runtime safety budget under Helm control', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async () => Response.json({
        id: 'chatcmpl-plan-budget',
        object: 'chat.completion',
        created: 1,
        model: 'google/gemma-4-e2b',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              mode: 'task',
              goal: 'Use the browser to inspect the requested page.',
              criteria: [{ type: 'browser.url', url: 'https://example.com' }],
              maxSteps: 1,
            }),
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    const task = await planner.createTask({
      threadId: 'thread-budget',
      userMessage: 'Open example.com and inspect it.',
    });

    expect(task).not.toHaveProperty('maxSteps');
  });

  it('short-circuits clear identity chat before task planning', async () => {
    const planner = new AiSdkTaskPlanner({
      model: {} as never,
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(planner.createTask({
      threadId: 'thread-chat',
      userMessage: 'Who are you?',
    })).resolves.toMatchObject({
      goal: 'Who are you?',
      criteria: [],
    });
  });

  it('generates a conversational final answer from the thread and tool evidence', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-response',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'I am Helm, your local desktop agent.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const generator = new AiSdkResponseGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });
    const result = {
      run: {
        id: 'run-chat',
        threadId: 'thread-chat',
        goal: 'Answer the user directly.',
        status: 'completed' as const,
        criteria: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      task: {
        id: 'task-chat',
        threadId: 'thread-chat',
        goal: 'Answer the user directly.',
        criteria: [],
      },
      history: [],
      steps: [],
      observations: [],
      finalVerification: { complete: true, criteria: [], summary: 'Response ready.' },
      status: 'completed' as const,
    } satisfies AgentRuntimeResult;

    await expect(generator.generate({
      userMessage: 'Who are you?',
      conversation: [{
        id: 'message-1',
        threadId: 'thread-chat',
        role: 'user',
        content: 'Who are you?',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      result,
    })).resolves.toBe('I am Helm, your local desktop agent.');
    expect(JSON.stringify(requestBody)).toContain('Who are you?');
  });

  it('streams conversational response deltas in order', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async () => {
        const chunks = [
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'I am ' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: { content: 'Helm.' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ];
        const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const generator = new AiSdkResponseGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });
    const result = {
      run: {
        id: 'run-stream',
        threadId: 'thread-stream',
        goal: 'Answer the user directly.',
        status: 'completed' as const,
        criteria: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      task: {
        id: 'task-stream',
        threadId: 'thread-stream',
        goal: 'Answer the user directly.',
        criteria: [],
      },
      history: [],
      steps: [],
      observations: [],
      finalVerification: { complete: true, criteria: [], summary: 'Response ready.' },
      status: 'completed' as const,
    } satisfies AgentRuntimeResult;
    const deltas: string[] = [];

    await expect(generator.stream({
      userMessage: 'Who are you?',
      conversation: [],
      result,
      onDelta: delta => deltas.push(delta),
    })).resolves.toBe('I am Helm.');
    expect(deltas).toEqual(['I am ', 'Helm.']);
  });

  it('converts AI SDK embeddings to the runtime Float32Array boundary', async () => {
    const provider = new AiSdkEmbeddingProvider({
      model: fakeEmbeddingModel([0.25, -0.5, 0.75]),
      dimensions: 3,
      requestTimeoutMs: 1000,
    });

    expect(Array.from(await provider.embed('hello Helm'))).toEqual([0.25, -0.5, 0.75]);
  });

  it('rejects an embedding response with the wrong configured dimension', async () => {
    const provider = new AiSdkEmbeddingProvider({
      model: fakeEmbeddingModel([0.25, -0.5]),
      dimensions: 3,
      requestTimeoutMs: 1000,
    });

    await expect(provider.embed('wrong size')).rejects.toThrow('expected 3');
  });

  it('targets the LM Studio OpenAI-compatible embeddings endpoint and model id', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestUrl = request.url;
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      },
    });

    const result = await embed({
      model: provider.embeddingModel('text-embedding-nomic-embed-text-v1.5'),
      value: 'hello Helm',
      maxRetries: 0,
    });

    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(requestUrl).toBe('http://localhost:1234/v1/embeddings');
    expect(requestBody).toMatchObject({
      model: 'text-embedding-nomic-embed-text-v1.5',
      input: ['hello Helm'],
    });
  });

  it('generates a thread title through the configured language model', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-title',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ title: 'Research twlite.dev' }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const generator = new AiSdkThreadTitleGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(generator.generate('  Research twlite.dev and save the page  ')).resolves.toBe('Research twlite.dev');
    expect(requestBody).toMatchObject({
      model: 'google/gemma-4-e2b',
      response_format: { type: 'json_schema' },
    });
  });

  it('falls back to the trimmed input when title generation fails', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async () => {
        throw new Error('LM Studio is unavailable');
      },
    });
    const generator = new AiSdkThreadTitleGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(generator.generate('  Save this page to a file  ')).resolves.toBe('Save this page to a file');
  });
});
