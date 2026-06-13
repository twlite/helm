import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStepSystemContext,
  pruneOlderScreenshotImages,
} from './step-context.ts';

describe('agent step context', () => {
  it('tells later steps to continue from completed tool results', () => {
    const messages = [
      {
        role: 'user',
        content: 'User objective:\nExtract GitHub profile information.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'open_application',
            input: { app: 'firefox' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'open_application',
            output: { ok: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'capture_screenshot',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'capture_screenshot',
            output: {
              ok: true,
              windows: [{ name: 'Mozilla Firefox' }],
            },
          },
        ],
      },
    ];

    const context = buildStepSystemContext({
      messages: messages as any,
      stepNumber: 2,
    });

    assert.match(context ?? '', /This is step 3/);
    assert.match(context ?? '', /Do not restart/);
    assert.match(
      context ?? '',
      /Completed tool calls in this run: open_application -> capture_screenshot/,
    );
    assert.match(context ?? '', /Latest completed tool: capture_screenshot/);
    assert.match(context ?? '', /Mozilla Firefox/);
  });

  it('keeps only the latest screenshot image payload', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'capture_screenshot',
            output: { imageBase64: 'old-image', ok: true },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'capture_screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Older screenshot summary.' },
                {
                  type: 'file-data',
                  data: 'older-model-image',
                  mediaType: 'image/png',
                },
              ],
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'capture_screenshot',
            output: { imageBase64: 'new-image', ok: true },
          },
        ],
      },
    ];

    const pruned = pruneOlderScreenshotImages(messages as any) as any[];

    assert.equal(pruned[0].content[0].output.imageBase64, '');
    assert.deepEqual(pruned[1].content[0].output.value, [
      { type: 'text', text: 'Older screenshot summary.' },
    ]);
    assert.equal(pruned[2].content[0].output.imageBase64, 'new-image');
  });
});
