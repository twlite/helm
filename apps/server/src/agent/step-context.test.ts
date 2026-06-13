import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendLatestScreenshotImageMessage,
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

  it('keeps completed navigation details visible after another screenshot', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'type_text',
            input: { delayMs: 12, text: 'dhunganakunjan.com.np' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'type_text',
            output: { length: 20, ok: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'press_key',
            input: { keyOrCombo: 'Enter' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'press_key',
            output: { keyOrCombo: 'Enter', ok: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-3',
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
            toolCallId: 'call-3',
            toolName: 'capture_screenshot',
            output: {
              geometry: { height: 768, width: 1366 },
              ok: true,
              windows: [{ name: 'Kunjan Dhungana - Mozilla Firefox' }],
            },
          },
        ],
      },
    ];

    const context = buildStepSystemContext({
      messages: messages as any,
      stepNumber: 6,
    });

    assert.match(context ?? '', /type_text called with text="dhunganakunjan\.com\.np"/);
    assert.match(context ?? '', /press_key called with key="Enter"/);
    assert.match(context ?? '', /do not claim navigation has not happened/i);
    assert.match(context ?? '', /page title in Firefox/);
  });

  it('requires Enter after typing a URL before treating navigation as complete', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'type_text',
            input: { delayMs: 12, text: 'twlite.dev' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'type_text',
            output: { length: 10, ok: true },
          },
        ],
      },
    ];

    const context = buildStepSystemContext({
      messages: messages as any,
      stepNumber: 2,
    });

    assert.match(context ?? '', /Enter has not been pressed/);
    assert.match(context ?? '', /next action should be press_key with Enter/);
  });

  it('requires a screenshot after pressing Enter on a URL before claiming the page is open', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'type_text',
            input: { delayMs: 12, text: 'twlite.dev' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'type_text',
            output: { length: 10, ok: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-2',
            toolName: 'press_key',
            input: { keyOrCombo: 'Enter' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'press_key',
            output: { keyOrCombo: 'Enter', ok: true },
          },
        ],
      },
    ];

    const context = buildStepSystemContext({
      messages: messages as any,
      stepNumber: 4,
    });

    assert.match(context ?? '', /no screenshot has verified the loaded page yet/);
    assert.match(context ?? '', /before claiming the webpage is open or empty/);
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
                  type: 'media',
                  data: 'older-model-image',
                  mediaType: 'image/png',
                },
                {
                  type: 'image-data',
                  data: 'older-model-image-2',
                  mediaType: 'image/png',
                },
                {
                  type: 'file-data',
                  data: 'older-model-file',
                  mediaType: 'application/pdf',
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

  it('appends the latest screenshot as a user image message for provider vision input', () => {
    const messages = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'capture_screenshot',
            output: {
              imageBase64: 'latest-image',
              mimeType: 'image/png',
              ok: true,
            },
          },
        ],
      },
    ];

    const next = appendLatestScreenshotImageMessage(messages as any) as any[];
    const injected = next.at(-1);

    assert.equal(next.length, 2);
    assert.equal(injected.role, 'user');
    assert.deepEqual(injected.content[1], {
      data: 'latest-image',
      filename: 'desktop-screenshot.png',
      mediaType: 'image/png',
      type: 'file',
    });
  });
});
