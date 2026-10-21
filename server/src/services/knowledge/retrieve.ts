// Hybrid retrieval over the knowledge bases a conversation enabled: vector
// similarity and BM25-style keywords, fused by rank, deduplicated, and cut to a
// context budget. Every passage carries a stable id (`kb:<document>#<ordinal>`)
// the answer can cite.

import { getDb } from '../../db/index.js';
import { runEmbeddings } from '../embeddings.js';
import { cosine, fuseRanks, keywordScores, norm, unpackVector } from './vectors.js';

export const DEFAULT_LIMIT = 6;
export const DEFAULT_CONTEXT_CHARS = 6000;
const MAX_CHUNKS_SCANNED = 50_000;

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export interface Passage {
  id: string;
  documentId: number;
  documentName: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  score: number;
}

export type Evidence = 'ok' | 'weak' | 'none';

export interface SearchResult {
  passages: Passage[];
  evidence: Evidence;
}

interface ChunkRow {
  id: number;
  document_id: number;
  ordinal: number;
  text: string;
  page: number | null;
  heading: string | null;
  embedding: Buffer | null;
  doc_name: string;
}

export function passageId(documentId: number, ordinal: number): string {
  return `kb:${documentId}#${ordinal}`;
}

/** Base ids from `baseIds` that exist, belong to `userId` and have indexed content. */
function usableBases(userId: number, baseIds: number[]): { id: number; family: string; dimensions: number }[] {
  if (baseIds.length === 0) return [];
  const marks = baseIds.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT id, embedding_family AS family, dimensions
      FROM kb_bases
     WHERE user_id = ? AND id IN (${marks})
       AND embedding_family IS NOT NULL AND dimensions IS NOT NULL
  `).all(userId, ...baseIds) as { id: number; family: string; dimensions: number }[];
}

export async function searchKnowledge(options: {
  userId: number;
  baseIds: number[];
  query: string;
  limit?: number;
  maxChars?: number;
}): Promise<SearchResult> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 12);
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_CHARS;
  const bases = usableBases(options.userId, options.baseIds);
  if (bases.length === 0) return { passages: [], evidence: 'none' };

  const db = getDb();
  type Candidate = Passage & { cosine: number; keyword: number };
  const candidates: Candidate[] = [];

  for (const base of bases) {
    const rows = db.prepare(`
      SELECT c.id, c.document_id, c.ordinal, c.text, c.page, c.heading, c.embedding, d.name AS doc_name
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
       WHERE c.base_id = ? AND d.status = 'ready'
       LIMIT ?
    `).all(base.id, MAX_CHUNKS_SCANNED) as ChunkRow[];
    if (rows.length === 0) continue;

    let queryVector: Float32Array;
    try {
      // Same family the base was indexed with: vectors from another model are
      // not comparable, so there is no fallback to a different one.
      const out = await runEmbeddings(base.family, [options.query]);
      if (out.dimensions !== base.dimensions) {
        throw new KnowledgeError('The embedding model no longer matches this knowledge base; reindex it');
      }
      queryVector = Float32Array.from(out.vectors[0]);
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError(
        `Could not embed the question (${error instanceof Error ? error.message : 'error'}); no documents were checked`,
      );
    }

    const qNorm = norm(queryVector);
    const cos = rows.map(r => {
      const v = unpackVector(r.embedding, base.dimensions);
      return v ? cosine(queryVector, v, qNorm) : 0;
    });
    const kw = keywordScores(options.query, rows.map(r => r.text));
    const fused = fuseRanks([cos.map(s => Math.max(s, 0)), kw]);

    rows.forEach((r, i) => {
      if (fused[i] <= 0) return;
      candidates.push({
        id: passageId(r.document_id, r.ordinal),
        documentId: r.document_id,
        documentName: r.doc_name,
        ordinal: r.ordinal,
        page: r.page,
        heading: r.heading,
        text: r.text,
        score: fused[i],
        cosine: cos[i],
        keyword: kw[i],
      });
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const passages: Passage[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const c of candidates) {
    if (passages.length >= limit) break;
    const fingerprint = c.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
    if (seen.has(fingerprint)) continue; // overlap or duplicate upload
    if (used + c.text.length > maxChars && passages.length > 0) break;
    seen.add(fingerprint);
    used += c.text.length;
    passages.push(c);
  }

  const best = candidates[0];
  let evidence: Evidence = 'none';
  if (best) {
    if (best.cosine >= 0.5 || (best.keyword > 0 && best.cosine >= 0.3)) evidence = 'ok';
    else if (best.cosine >= 0.25 || best.keyword > 0) evidence = 'weak';
  }
  return { passages: evidence === 'none' ? [] : passages, evidence };
}

/** Citation ids in `text` (`[kb:12#3]`) that were not among the retrieved passages. */
export function unretrievedCitations(text: string, retrievedIds: ReadonlySet<string>): string[] {
  const found = text.match(/kb:\d+#\d+/g) ?? [];
  return [...new Set(found)].filter(id => !retrievedIds.has(id));
}
