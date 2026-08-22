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
});
