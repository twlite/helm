import { describe, expect, it } from 'bun:test';
import type { HelmEvent, RunDetails, RunStep } from '../src/types';
import { formatDiagnosticValue, formatRunActivityForClipboard } from '../src/run-activity-clipboard';

function step(overrides: Partial<RunStep> = {}): RunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    stepIndex: 0,
    phase: 'act',
    createdAt: '2026-09-28T07:41:42.548Z',
    completedAt: '2026-09-28T07:41:43.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<RunDetails> = {}): RunDetails {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    sourceMessageId: 'message-1',
    goal: 'Fetch the page and save the result.',
    status: 'completed',
    criteria: [],
    createdAt: '2026-09-28T07:41:40.000Z',
    startedAt: '2026-09-28T07:41:41.000Z',
    completedAt: '2026-09-28T07:41:50.000Z',
    steps: [],
    ...overrides,
  };
}

function event(type: HelmEvent['type'], timestamp: string, payload: unknown = {}): HelmEvent {
  return { type, timestamp, runId: 'run-1', payload };
}

describe('run activity clipboard formatter', () => {
  it('formats successful tool activity, inputs, results, and observations', () => {
    const text = formatRunActivityForClipboard(run({
      steps: [step({
        toolName: 'browser.read',
        decision: { type: 'action', tool: 'browser.read', input: { semanticQuery: 'exchange rates' } },
        toolInput: { semanticQuery: 'exchange rates' },
        toolResult: { ok: true, data: { tableCount: 2 } },
        observation: { browser: { url: 'https://example.test/rates', title: 'Rates' } },
      })],
    }), { historySource: 'server' });

    expect(text).toContain('Run ID: run-1');
    expect(text).toContain('Tool: browser.read');
    expect(text).toContain('Input (proposed and executed)');
    expect(text).toContain('"semanticQuery": "exchange rates"');
    expect(text).toContain('Tool result:');
    expect(text).toContain('"tableCount": 2');
    expect(text).toContain('Observation:');
    expect(text).toContain('https://example.test/rates');
    expect(text).toContain('History source: fresh server run details');
  });

  it('includes failed tool codes and the final run error', () => {
    const text = formatRunActivityForClipboard(run({
      status: 'failed',
      error: { code: 'MODEL_TURN_BUDGET_EXCEEDED', message: 'The model budget was exceeded.', details: { turn: 12 } },
      steps: [step({
        toolName: 'browser.navigate',
        toolResult: { ok: false, error: { code: 'BROWSER_NAVIGATION_FAILED', message: 'ERR_EMPTY_RESPONSE' } },
      })],
    }), {
      historySource: 'server',
      runtimeEvents: {
        runId: 'run-1',
        startedObserved: true,
        truncated: false,
        events: [
          event('run.started', '2026-09-28T07:41:41.000Z'),
          event('run.failed', '2026-09-28T07:41:50.000Z', { code: 'MODEL_TURN_BUDGET_EXCEEDED' }),
        ],
      },
    });

    expect(text).toContain('BROWSER_NAVIGATION_FAILED');
    expect(text).toContain('Final status:\nfailed');
    expect(text).toContain('Code: MODEL_TURN_BUDGET_EXCEEDED');
    expect(text).toContain('The model budget was exceeded.');
    expect(text).toContain('"turn": 12');
    expect(text).toContain('Event: run.failed');
  });

  it('renders schema validation model request outcomes and their input issues', () => {
    const text = formatRunActivityForClipboard(run({
      diagnostics: {
        modelTurns: 3,
        finalizationTurns: 0,
        modelRequests: 3,
        toolActions: 1,
        completionAttempts: 0,
        completionRejections: 0,
        contextCompactions: 0,
        lastUnsatisfiedRequirements: ['outputFile'],
        modelRequestOutcomes: [{
          request: 2,
          kind: 'acting-turn',
          providerCalls: 1,
          providerRetries: 0,
          outcome: 'tool-call',
          finishReason: 'tool-calls',
          toolCalls: [{
            tool: 'fs.write',
            outcome: 'schema-validation-failed',
            input: { path: 'forex.txt', sourceRef: 9 },
            validationIssues: [{ path: ['sourceRef'], code: 'invalid_type', message: 'Expected a string.' }],
          }],
        }],
      },
    }));

    expect(text).toContain('Request 2: kind=acting-turn');
    expect(text).toContain('fs.write: schema-validation-failed');
    expect(text).toContain('"sourceRef": 9');
    expect(text).toContain('sourceRef · invalid_type: Expected a string.');
    expect(text).toContain('"lastUnsatisfiedRequirements"');
  });

  it('includes structured rejected-requirement recovery diagnostics', () => {
    const text = formatRunActivityForClipboard(run({
      diagnostics: {
        modelTurns: 6,
        finalizationTurns: 1,
        modelRequests: 7,
        toolActions: 6,
        completionAttempts: 2,
        completionRejections: 1,
        contextCompactions: 0,
        lastUnsatisfiedRequirements: [],
        requirementRejections: [{
          requirementId: 'outputFile',
          reasonCode: 'BROWSER_PROVENANCE_REQUIRED',
          message: 'forex.txt was written with fs.writeText; use fs.writeFromRef with the current document ref.',
          correctiveTool: 'fs.writeFromRef',
          rejectedAction: { tool: 'fs.writeText', path: 'forex.txt', receiptId: 'receipt-write-text' },
          correctiveArtifact: {
            sourceRef: 'd1-12345678-1',
            sourceType: 'document',
            sourceUrl: 'https://example.test/rates',
            sourceRevision: 1,
            sourceCapturedAt: '2026-09-28T07:41:42.000Z',
            sourceStructuredBlockCount: 2,
            sourceTableCount: 2,
            complete: true,
          },
        }],
      },
    }));

    expect(text).toContain('requirementRejections');
    expect(text).toContain('BROWSER_PROVENANCE_REQUIRED');
    expect(text).toContain('fs.writeFromRef');
    expect(text).toContain('d1-12345678-1');
  });

  it('copies why a raw export is pending after a no-match browser read', () => {
    const text = formatRunActivityForClipboard(run({
      diagnostics: {
        modelTurns: 6,
        finalizationTurns: 0,
        modelRequests: 6,
        toolActions: 5,
        completionAttempts: 1,
        completionRejections: 1,
        contextCompactions: 0,
        lastUnsatisfiedRequirements: ['outputFile: no complete browser export artifact exists'],
        requirementRejections: [{
          requirementId: 'outputFile',
          reasonCode: 'NO_EXPORTABLE_BROWSER_ARTIFACT',
          message: 'No complete current-run browser export artifact exists. The latest browser.read selected no content. tableCount=2; requestedBlockTypes=text; export.complete=false.',
          correctiveTool: 'browser.read',
          rejectedAction: { tool: 'fs.writeText', path: 'forex.txt', receiptId: 'receipt-preview-write' },
          evidence: {
            exportAvailable: false,
            latestBrowserReadFailure: {
              code: 'BROWSER_READ_NO_MATCHING_CONTENT',
              pageType: 'data_table',
              requestedBlockTypes: ['text'],
              availableBlockTypes: { table: 2, form: 3 },
              tableCount: 2,
              selectedBlockCount: 0,
              exportAvailable: false,
            },
          },
        }],
      },
    }));

    expect(text).toContain('NO_EXPORTABLE_BROWSER_ARTIFACT');
    expect(text).toContain('BROWSER_READ_NO_MATCHING_CONTENT');
    expect(text).toContain('"form": 3');
    expect(text).toContain('"table": 2');
    expect(text).toContain('"correctiveTool": "browser.read"');
    expect(text).toContain('receipt-preview-write');
  });

  it('includes bounded provider rejection details in the copied log', () => {
    const text = formatRunActivityForClipboard(run({
      status: 'failed',
      error: { code: 'MODEL_PROVIDER_REQUEST_FAILED', message: 'The model provider rejected the request with HTTP 400.' },
      diagnostics: {
        modelTurns: 1,
        finalizationTurns: 0,
        modelRequests: 1,
        toolActions: 0,
        completionAttempts: 0,
        completionRejections: 0,
        contextCompactions: 0,
        lastUnsatisfiedRequirements: ['browserVisited1'],
        modelRequestOutcomes: [{
          request: 1,
          kind: 'acting-turn',
          providerCalls: 1,
          providerRetries: 0,
          outcome: 'provider-error',
          errorName: 'AI_APICallError',
          providerError: {
            statusCode: 400,
            message: 'Bad Request',
            responseBody: '{"error":"Invalid tool parameters JSON Schema"}',
            responseBodyTruncated: false,
            url: 'http://localhost:1234/v1/chat/completions',
            isRetryable: false,
          },
        }],
      },
    }));

    expect(text).toContain('Code: MODEL_PROVIDER_REQUEST_FAILED');
    expect(text).toContain('statusCode');
    expect(text).toContain('Invalid tool parameters JSON Schema');
    expect(text).toContain('http://localhost:1234/v1/chat/completions');
  });

  it('shows proposed and executed input separately when runtime inputs differ', () => {
    const text = formatRunActivityForClipboard(run({
      steps: [step({
        toolName: 'tool.executed',
        decision: { type: 'action', tool: 'tool.proposed', input: { path: 'outside.txt', content: 'data' } },
        toolInput: { path: 'output.txt', content: 'data' },
      })],
    }));

    expect(text).toContain('Proposed input:');
    expect(text).toContain('"path": "outside.txt"');
    expect(text).toContain('Executed input:');
    expect(text).toContain('"path": "output.txt"');
    expect(text).toContain('Proposed tool: tool.proposed');
    expect(text).toContain('Executed tool: tool.executed');
  });

  it('includes per-step and final verification, plus compiled requirement state', () => {
    const verification = {
      complete: true,
      summary: 'All requested effects verified.',
      criteria: [{
        criterion: { type: 'file.exists', path: 'output.txt' } as const,
        passed: true,
        message: 'The output file exists.',
      }],
      requirements: [{
        requirement: { id: 'outputFile', description: 'Save the requested output.' },
        passed: true,
        message: 'A current-run write receipt exists.',
      }],
    };
    const text = formatRunActivityForClipboard(run({
      steps: [step({ verification })],
      state: {
        task: { requirements: [{ id: 'outputFile', description: 'Save the requested output.' }] },
        completedRequirementIds: ['outputFile'],
      } as RunDetails['state'],
    }));

    expect(text).toContain('Verification:');
    expect(text).toContain('All requested effects verified.');
    expect(text).toContain('[satisfied] outputFile');
    expect(text).toContain('Final verification:');
    expect(text).toContain('Requirement state:');
  });

  it('omits screenshot/base64 blobs and bounds long ordinary strings', () => {
    const huge = 'ordinary diagnostic text\n'.repeat(1_000);
    const text = formatRunActivityForClipboard(run({
      steps: [step({
        observation: {
          screenshot: `data:image/png;base64,${'a'.repeat(30_000)}`,
          base64: 'b'.repeat(12_000),
          response: huge,
        },
      })],
    }));

    expect(text).toContain('omitted screenshot payload');
    expect(text).toContain('omitted binary payload');
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(100_000);
    expect(text).not.toContain('a'.repeat(5_000));
  });

  it('handles undefined, circular values, Error-like values, and unserializable objects', () => {
    const circular: Record<string, unknown> = { value: undefined };
    circular.self = circular;
    const error = Object.assign(new Error('provider failed'), { code: 'PROVIDER_ERROR', details: circular });
    const unreadable = new Proxy({}, { ownKeys: () => { throw new Error('cannot enumerate'); } });

    expect(formatDiagnosticValue(undefined)).toBe('"<undefined>"');
    expect(formatDiagnosticValue(circular)).toContain('<circular reference>');
    expect(formatDiagnosticValue(error)).toContain('PROVIDER_ERROR');
    expect(formatDiagnosticValue(unreadable)).toContain('<unreadable object>');
    expect(() => formatRunActivityForClipboard(run({ steps: [step({ observation: circular, toolResult: error as never })] }))).not.toThrow();
  });

  it('orders runtime events and persisted steps chronologically', () => {
    const text = formatRunActivityForClipboard(run({
      steps: [
        step({ id: 'later-step', stepIndex: 1, createdAt: '2026-09-28T07:41:44.000Z', toolName: 'fs.write' }),
        step({ id: 'earlier-step', stepIndex: 0, createdAt: '2026-09-28T07:41:42.000Z', toolName: 'browser.read' }),
      ],
    }), {
      runtimeEvents: {
        runId: 'run-1',
        startedObserved: true,
        truncated: false,
        events: [
          event('run.progress', '2026-09-28T07:41:43.000Z', { summary: 'Read page.' }),
          event('run.started', '2026-09-28T07:41:41.000Z'),
          event('run.completed', '2026-09-28T07:41:45.000Z', { status: 'completed' }),
        ],
      },
    });

    const positions = [
      text.indexOf('[1] 2026-09-28T07:41:41.000Z'),
      text.indexOf('[2] 2026-09-28T07:41:42.000Z'),
      text.indexOf('[3] 2026-09-28T07:41:43.000Z'),
      text.indexOf('[4] 2026-09-28T07:41:44.000Z'),
      text.indexOf('[5] 2026-09-28T07:41:45.000Z'),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(text).toContain('Event: run.progress');
    expect(text).toContain('Event: run.started');
    expect(text).toContain('Event: run.completed');
  });

  it('warns when only locally loaded history or a partial runtime event stream is available', () => {
    const text = formatRunActivityForClipboard(run(), {
      historySource: 'local',
      historyRefreshWarning: 'Network unavailable.',
      runtimeEvents: { runId: 'run-1', events: [], startedObserved: false, truncated: true, connectionInterrupted: true },
    });

    expect(text).toContain('complete persisted run history was not freshly fetched');
    expect(text).toContain('Could not refresh run history: Network unavailable.');
    expect(text).toContain('complete WebSocket event stream was not captured');
    expect(text).toContain('event buffer reached its limit');
    expect(text).toContain('WebSocket disconnected while this run was active');
  });
});
