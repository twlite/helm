import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAgentSystemPrompt } from './prompt.ts';

describe('buildAgentSystemPrompt', () => {
  it('allows keyboard shortcuts when they are more reliable than visual clicks', () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: undefined,
      memoryContext: [],
      summaryContext: null,
    });

    assert.match(prompt, /Prefer keyboard shortcuts/);
    assert.match(prompt, /Ctrl\+L/);
    assert.match(prompt, /Ctrl\+F/);
    assert.match(prompt, /verify with a screenshot/);
  });
});
