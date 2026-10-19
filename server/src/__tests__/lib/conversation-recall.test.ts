import { describe, expect, it } from 'vitest';
import {
  rankRecallSnippets,
  scoreRecallTurn,
  tokenizeRecallQuery,
  turnsFromMessages,
  type RecallTurnInput,
} from '../../lib/conversation-recall.js';

describe('conversation-recall helpers', () => {
  it('extracts plain user/assistant turns and skips empties', () => {
    expect(turnsFromMessages([
      { role: 'user', content: '  hello  ' },
      { role: 'system', content: 'nope' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'hi' },
    ])).toEqual([
      { turnIndex: 0, role: 'user', content: 'hello' },
      { turnIndex: 3, role: 'assistant', content: 'hi' },
    ]);
  });

  it('tokenises with diacritic folding', () => {
    expect(tokenizeRecallQuery('Cum mă cheamă?')).toEqual(['cum', 'ma', 'cheama']);
  });

  it('ranks an identity statement for a name question', () => {
    const now = 1_700_000_000_000;
    const turns: RecallTurnInput[] = [
      {
        conversationId: 1,
        title: 'Ma numesc Bala Alexandru',
        role: 'user',
        content: 'Ma numesc Bala Alexandru',
        updatedAtMs: now - 60_000,
        turnIndex: 0,
      },
      {
        conversationId: 2,
        title: 'weather',
        role: 'user',
        content: 'How is the weather in Bucharest?',
        updatedAtMs: now,
        turnIndex: 0,
      },
    ];

    const snippets = rankRecallSnippets('cum ma cheama?', turns, { nowMs: now, limit: 3 });
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].content).toMatch(/Bala Alexandru/i);
    expect(snippets[0].conversationId).toBe(1);
  });

  it('scores zero when nothing overlaps and it is not an identity hit', () => {
    const score = scoreRecallTurn(['weather'], {
      conversationId: 1,
      title: 'notes',
      role: 'user',
      content: 'I like TypeScript',
      updatedAtMs: Date.now(),
      turnIndex: 0,
    });
    expect(score).toBe(0);
  });
});
