// Pull the incremental text out of a streaming chunk for token counting.
// Must tolerate chunks that carry no `choices` array at all: some providers
// (e.g. Groq) emit usage/keepalive frames shaped like `{usage:{...}}` with no
// `choices`. Indexing `chunk.choices[0]` on those throws "Cannot read
// properties of undefined (reading '0')", which — once the SSE stream has
// started — aborts the response mid-flight with no chance to fall back.
export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

// Pull the incremental reasoning text out of a streaming chunk. Reasoning
// models stream thinking via `reasoning_content` (Z.ai, DeepSeek-style — the
// <think> extractor in base.ts normalizes inline tags into the same field) or
// `reasoning` (Ollama-style) before the first visible answer token; both
// spellings must count for ttfb and output-token estimates. Same shape
// tolerance as streamChunkText. (#764)
export function streamReasoningText(chunk: any): string {
  const delta = chunk?.choices?.[0]?.delta;
  const r = delta?.reasoning_content ?? delta?.reasoning;
  return typeof r === 'string' ? r : '';
}
