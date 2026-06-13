import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('screenshot tool model output', () => {
  it('returns screenshot images as media content for model vision input', async () => {
    process.env.EMBED_MODEL ??= 'test-embed-model';
    process.env.LLM_BASE_URL ??= 'http://localhost:11434/v1';
    process.env.MODEL_PROVIDER ??= 'test-provider';
    process.env.VLM_MODEL ??= 'test-vlm-model';

    const { buildScreenshotTools } = await import('./screenshot.ts');
    const tools = buildScreenshotTools({
      capture: {
        onToolCall: () => {},
        onToolResult: () => {},
      },
      context: {
        abortSignal: new AbortController().signal,
        conversationId: 'conversation-1',
        runId: 'run-1',
      },
    });

    const output = await (tools.capture_screenshot as any).toModelOutput({
      output: {
        bytes: 12,
        cursor: { x: 10, y: 20 },
        geometry: { height: 768, width: 1366 },
        imageBase64: 'base64-image',
        mimeType: 'image/png',
        ok: true,
        windows: [{ name: 'Kunjan Dhungana - Mozilla Firefox' }],
      },
      toolCallId: 'tool-call-1',
      input: {},
    });

    assert.equal(output.type, 'content');
    assert.deepEqual(output.value[1], {
      data: 'base64-image',
      mediaType: 'image/png',
      type: 'media',
    });
    assert.match(output.value[0].text, /Screenshot captured/);
    assert.match(output.value[0].text, /Kunjan Dhungana/);
  });
});
