// Split a document into retrievable passages. Pure, no I/O.
//
// Input is a list of pages (a plain text file is one page). Paragraphs are
// packed into chunks of about TARGET_CHARS, a long paragraph is cut on
// sentence boundaries, and consecutive chunks of a page overlap a little so a
// fact on a boundary is not lost. Each chunk remembers its page and the most
// recent Markdown-style heading above it.

export const TARGET_CHARS = 1200;
export const OVERLAP_CHARS = 150;
export const MAX_CHUNKS_PER_DOCUMENT = 2000;

export interface PageText {
  /** 1-based page number; null for formats without pages. */
  page: number | null;
  text: string;
}

export interface ChunkOut {
  ordinal: number;
  text: string;
  page: number | null;
  heading: string | null;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

function splitLong(paragraph: string): string[] {
  if (paragraph.length <= TARGET_CHARS) return [paragraph];
  const sentences = paragraph.match(/[^.!?。\n]+[.!?。]*\s*/g) ?? [paragraph];
  const parts: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > TARGET_CHARS) {
      parts.push(cur.trim());
      cur = '';
    }
    if (s.length > TARGET_CHARS) {
      // No sentence boundary to use: hard cut.
      for (let i = 0; i < s.length; i += TARGET_CHARS) parts.push(s.slice(i, i + TARGET_CHARS).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function chunkPages(pages: PageText[]): ChunkOut[] {
  const out: ChunkOut[] = [];
  let heading: string | null = null;

  for (const page of pages) {
    const paragraphs = page.text
      .replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(Boolean);

    let buf = '';
    let bufHeading: string | null = heading;
    const flush = () => {
      const text = buf.trim();
      if (text) {
        out.push({ ordinal: out.length, text, page: page.page, heading: bufHeading });
      }
      // Carry the tail forward as overlap into the next chunk of this page.
      buf = text.length > OVERLAP_CHARS * 2 ? text.slice(-OVERLAP_CHARS) : '';
      bufHeading = heading;
    };

    for (const paragraph of paragraphs) {
      const h = HEADING_RE.exec(paragraph.split('\n')[0]);
      if (h) heading = h[1].trim().slice(0, 200);
      for (const piece of splitLong(paragraph)) {
        if (buf && buf.length + piece.length + 2 > TARGET_CHARS) {
          flush();
          if (out.length >= MAX_CHUNKS_PER_DOCUMENT) return out;
        }
        if (!buf) bufHeading = heading;
        buf += (buf ? '\n\n' : '') + piece;
      }
    }
    flush();
    if (out.length >= MAX_CHUNKS_PER_DOCUMENT) return out.slice(0, MAX_CHUNKS_PER_DOCUMENT);
  }
  return out;
}

/** Page list for plain text: one page, or split on form feeds. */
export function pagesFromText(text: string): PageText[] {
  const parts = text.split('\f');
  if (parts.length === 1) return [{ page: null, text }];
  return parts.map((t, i) => ({ page: i + 1, text: t }));
}
