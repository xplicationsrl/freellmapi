import { describe, it, expect } from 'vitest';
import { chunkPages, pagesFromText, TARGET_CHARS } from '../../services/knowledge/chunker.js';
import {
  cosine, fuseRanks, keywordScores, packVector, unpackVector,
} from '../../services/knowledge/vectors.js';
import { unretrievedCitations } from '../../services/knowledge/retrieve.js';

describe('chunkPages', () => {
  it('keeps page numbers and the heading above a chunk', () => {
    const chunks = chunkPages([
      { page: 1, text: '# Revenue\n\nSales grew in March.' },
      { page: 2, text: 'More detail about April.' },
    ]);
    expect(chunks[0].page).toBe(1);
    expect(chunks[0].heading).toBe('Revenue');
    expect(chunks[chunks.length - 1].page).toBe(2);
    expect(chunks.map(c => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('keeps chunks near the target size', () => {
    const para = 'Sentence number one is here. '.repeat(200);
    const chunks = chunkPages([{ page: null, text: para }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS + 200);
  });

  it('splits plain text on form feeds into pages', () => {
    expect(pagesFromText('a\fb').map(p => p.page)).toEqual([1, 2]);
    expect(pagesFromText('a')).toEqual([{ page: null, text: 'a' }]);
  });
});

describe('vectors', () => {
  it('round-trips a vector through the BLOB form', () => {
    const v = [0.5, -1.25, 3];
    const out = unpackVector(packVector(v), 3);
    expect(out).not.toBeNull();
    expect(Array.from(out!)).toEqual(v);
  });

  it('rejects a BLOB of the wrong size', () => {
    expect(unpackVector(packVector([1, 2]), 3)).toBeNull();
  });

  it('computes cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it('ranks keyword matches and fuses rankings', () => {
    const scores = keywordScores('monthly growth', ['revenue growth by month', 'unrelated text', 'monthly growth rate']);
    expect(scores[2]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBe(0);
    const fused = fuseRanks([[0.9, 0.1, 0.5], [0, 0, 3]]);
    expect(fused[2]).toBeGreaterThan(fused[1]);
  });
});

describe('unretrievedCitations', () => {
  it('flags citations that were never retrieved', () => {
    const retrieved = new Set(['kb:1#0', 'kb:1#1']);
    expect(unretrievedCitations('See [kb:1#0] and [kb:9#4].', retrieved)).toEqual(['kb:9#4']);
    expect(unretrievedCitations('No sources.', retrieved)).toEqual([]);
  });
});
