import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChatCompletionRequest } from './compat.ts';

describe('OpenAI compatibility translation', () => {
  it('translates function tools and multimodal tool results', () => {
    const request = parseChatCompletionRequest({
      messages: [
        { content: 'What do you see?', role: 'user' },
        {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{}',
                name: 'screenshot',
              },
              id: 'call-screenshot',
              type: 'function',
            },
          ],
        },
        {
          content: JSON.stringify([
            { text: 'Screenshot captured.' },
            { data: 'AQ==', mediaType: 'image/png', type: 'media' },
          ]),
          role: 'tool',
          tool_call_id: 'call-screenshot',
        },
      ],
      model: 'codex',
      tools: [
        {
          function: {
            description: 'Capture the current screen.',
            name: 'screenshot',
            parameters: {
              additionalProperties: false,
              properties: {},
              type: 'object',
            },
          },
          type: 'function',
        },
      ],
    });

    assert.deepEqual(request.tools, [
      {
        description: 'Capture the current screen.',
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: 'object',
        },
        name: 'screenshot',
      },
    ]);
    assert.deepEqual(request.toolResults, [
      {
        content: [
          { text: 'Screenshot captured.', type: 'text' },
          { type: 'image', url: 'data:image/png;base64,AQ==' },
        ],
        toolCallId: 'call-screenshot',
      },
    ]);
    assert.deepEqual(request.history, [
      {
        kind: 'input',
        part: { text: 'USER:\nWhat do you see?', type: 'text' },
      },
      {
        arguments: '{}',
        id: 'call-screenshot',
        kind: 'tool-call',
        name: 'screenshot',
      },
      {
        content: [
          { text: 'Screenshot captured.', type: 'text' },
          { type: 'image', url: 'data:image/png;base64,AQ==' },
        ],
        id: 'call-screenshot',
        kind: 'tool-result',
      },
    ]);
  });

  it('preserves Helm screenshot context for stateless callers', () => {
    const request = parseChatCompletionRequest({
      messages: [
        { content: 'Inspect the screen.', role: 'user' },
        {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: { arguments: '{}', name: 'screenshot' },
              id: 'call-screenshot',
              type: 'function',
            },
          ],
        },
        {
          content: JSON.stringify([
            { text: 'Screenshot captured.' },
            { data: 'AQ==', mediaType: 'image/png', type: 'media' },
          ]),
          role: 'tool',
          tool_call_id: 'call-screenshot',
        },
        {
          content: [
            {
              text: 'Latest desktop screenshot image for visual inspection. Use this image to read visible page text and UI state.',
              type: 'text',
            },
            {
              image_url: { url: 'data:image/png;base64,AQ==' },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ],
    });

    assert.equal(request.history.length, 5);
    assert.deepEqual(request.history.slice(-2), [
      {
        kind: 'input',
        part: {
          text: 'USER:\nLatest desktop screenshot image for visual inspection. Use this image to read visible page text and UI state.',
          type: 'text',
        },
      },
      { kind: 'input', part: { type: 'image', url: 'data:image/png;base64,AQ==' } },
    ]);
    assert.deepEqual(request.input.slice(-2), [
      {
        text: 'USER:\nLatest desktop screenshot image for visual inspection. Use this image to read visible page text and UI state.',
        type: 'text',
      },
      { type: 'image', url: 'data:image/png;base64,AQ==' },
    ]);
  });
});
