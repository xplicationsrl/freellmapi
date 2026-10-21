// Embedding storage and similarity. Vectors are stored as little-endian
// float32 BLOBs and compared in process: fine for the collection sizes a single
// self-hosted install holds (tens of thousands of chunks), with no native
// extension to package for the Docker and desktop builds. The interface is the
// seam for a vector index later.

export function packVector(vector: number[]): Buffer {
  const buf = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buf.writeFloatLE(vector[i], i * 4);
  return buf;
}

export function unpackVector(blob: Buffer | Uint8Array | null | undefined, dimensions: number): Float32Array | null {
  if (!blob || blob.byteLength !== dimensions * 4) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i += 1) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** Cosine similarity; 0 for mismatched lengths or zero vectors. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>, normA = norm(a)): number {
  if (a.length !== b.length) return 0;
  const nb = norm(b);
  if (normA === 0 || nb === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot / (normA * nb);
}

const STOP = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from', 'have', 'has', 'had',
  'not', 'but', 'you', 'your', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'about', 'into',
  'than', 'then', 'there', 'their', 'they', 'will', 'would', 'could', 'should', 'can', 'did', 'does',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => t.length > 2 && !STOP.has(t));
}

/**
 * BM25-style keyword scores for `docs` against `query`. Document frequency is
 * taken over the candidate set, which is the whole base when it is searched.
 */
export function keywordScores(query: string, docs: string[]): number[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0 || docs.length === 0) return docs.map(() => 0);
  const tokenized = docs.map(tokenize);
  const avgLen = tokenized.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of q) {
    let n = 0;
    for (const t of tokenized) if (t.includes(term)) n += 1;
    df.set(term, n);
  }
  const k1 = 1.2;
  const b = 0.75;
  return tokenized.map(tokens => {
    let score = 0;
    for (const term of q) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      let tf = 0;
      for (const t of tokens) if (t === term) tf += 1;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLen)));
    }
    return score;
  });
}

/** Reciprocal-rank fusion of several score arrays (higher = better). */
export function fuseRanks(scoreLists: number[][], k = 60): number[] {
  const n = scoreLists[0]?.length ?? 0;
  const fused = new Array<number>(n).fill(0);
  for (const scores of scoreLists) {
    const order = scores.map((s, i) => ({ s, i })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    order.forEach((x, rank) => { fused[x.i] += 1 / (k + rank + 1); });
  }
  return fused;
}
