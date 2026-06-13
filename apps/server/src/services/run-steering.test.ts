import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addRunSteeringMessage,
  buildRunSteeringContext,
  clearRunSteeringMessages,
} from './run-steering.ts';

describe('run steering context', () => {
  it('builds and clears active run steering instructions', () => {
    clearRunSteeringMessages('run-1');

    addRunSteeringMessage({
      runId: 'run-1',
      text: 'Extract the visible profile text and save it.',
    });

    const context = buildRunSteeringContext('run-1');
    assert.match(context ?? '', /Live user steering/);
    assert.match(context ?? '', /Extract the visible profile text/);

    clearRunSteeringMessages('run-1');
    assert.equal(buildRunSteeringContext('run-1'), null);
  });
});
