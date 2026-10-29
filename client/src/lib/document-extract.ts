// Text extraction for PDF and Word (.docx) attachments in the Playground.
//
// Everything happens in the browser: the document is reduced to plain text and
// then rides the same path as any other text-like attachment (inlined into the
// message as a fenced block), so the server and every free-tier provider see
// ordinary text and nothing new has to be trusted or stored.
//
//   - PDF: pdf.js, loaded on first use so it costs nothing until someone
//     attaches a PDF. Only the embedded text layer is read — a scanned PDF has
//     none; renderPdfPages() turns its pages into images for a vision model.
//   - DOCX: a .docx is a zip holding word/document.xml. The zip is read with
//     the platform's DecompressionStream and the XML with DOMParser, so no
//     parser library ships to the client.
//
// Legacy binary .doc is not supported (no standard-library way to read it).

import { MAX_TEXT_BYTES, AttachmentError, encode, fitWithin } from '@/lib/attachments'

/** Largest PDF/DOCX we will even try to open. */
export const MAX_DOCUMENT_BYTES = 10_000_000
/** PDFs with more pages than this are cut off; the cap on text usually hits first. */
const MAX_PDF_PAGES = 200
/** Upper bound for word/document.xml once inflated (a zip-bomb guard). */
const MAX_DOCX_XML_BYTES = 50_000_000

const TRUNCATION_MARKER = '\n\n[… document truncated …]'

export interface ExtractedDocument {
  text: string
  /** True when the text was cut at the size cap. */
  truncated: boolean
}

/**
 * Normalise extracted text and apply the size cap. Returns null when nothing
 * readable is left (a scanned PDF, an empty document).
 */
export function finishExtracted(raw: string, max = MAX_TEXT_BYTES): ExtractedDocument | null {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return null
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max).trimEnd() + TRUNCATION_MARKER, truncated: true }
}

// ── DOCX ────────────────────────────────────────────────────────────────────

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

interface ZipEntry {
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

/** Index a zip's central directory. Throws AttachmentError('unreadable') if it is not a zip. */
function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-central-directory record sits in the last 64 KB + 22 bytes.
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd === -1) throw new AttachmentError('unreadable')

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries = new Map<string, ZipEntry>()
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new AttachmentError('unreadable')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.set(name, {
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = entry.localOffset
  if (header + 30 > bytes.length || view.getUint32(header, true) !== 0x04034b50) {
    throw new AttachmentError('unreadable')
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new AttachmentError('unreadable')
  if (entry.uncompressedSize > MAX_DOCX_XML_BYTES) throw new AttachmentError('too-large')
  const inflated = new Response(data as BodyInit).body!.pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(inflated).arrayBuffer())
}

function wordElements(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter(c => c.namespaceURI === WORD_NS && c.localName === localName)
}

/** Text of one paragraph: runs, tabs and line breaks, in document order. */
function paragraphText(paragraph: Element): string {
  let out = ''
  const visit = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI !== WORD_NS) { visit(child); continue }
      switch (child.localName) {
        case 't': out += child.textContent ?? ''; break
        case 'tab': out += '\t'; break
        case 'br': case 'cr': out += '\n'; break
        // Text boxes hold their own paragraphs; they are not part of this one.
        case 'txbxContent': break
        // Tracked deletions are not part of the document as it reads now.
        case 'del': break
        default: visit(child)
      }
    }
  }
  visit(paragraph)
  return out
}

/** Block-level walk: paragraphs become lines, table rows become tab-separated lines. */
function blockText(container: Element, lines: string[]): void {
  for (const child of Array.from(container.children)) {
    if (child.namespaceURI !== WORD_NS) { blockText(child, lines); continue }
    if (child.localName === 'p') {
      lines.push(paragraphText(child))
    } else if (child.localName === 'tbl') {
      for (const row of wordElements(child, 'tr')) {
        const cells = wordElements(row, 'tc').map(cell => {
          const cellLines: string[] = []
          blockText(cell, cellLines)
          return cellLines.filter(Boolean).join(' ')
        })
        lines.push(cells.join('\t'))
      }
    } else if (child.localName !== 'sectPr') {
      blockText(child, lines)
    }
  }
}

/** Plain text of a parsed word/document.xml. Exported for tests. */
export function docxXmlToText(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new AttachmentError('unreadable')
  const body = doc.getElementsByTagNameNS(WORD_NS, 'body')[0]
  if (!body) throw new AttachmentError('unreadable')
  const lines: string[] = []
  blockText(body, lines)
  return lines.join('\n')
}

export async function extractDocxText(file: Blob): Promise<ExtractedDocument | null> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentError('too-large')
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const entry = readZipEntries(bytes).get('word/document.xml')
    if (!entry) throw new AttachmentError('unreadable')
    const xml = new TextDecoder().decode(await readZipEntry(bytes, entry))
    return finishExtracted(docxXmlToText(xml))
  } catch (err) {
    throw err instanceof AttachmentError ? err : new AttachmentError('unreadable')
  }
}

// ── PDF ─────────────────────────────────────────────────────────────────────

async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

export async function extractPdfText(file: Blob): Promise<ExtractedDocument | null> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentError('too-large')
  try {
    const pdfjs = await loadPdfjs()
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    try {
      const pdf = await loadingTask.promise
      const pages: string[] = []
      let length = 0
      const lastPage = Math.min(pdf.numPages, MAX_PDF_PAGES)
      for (let number = 1; number <= lastPage && length <= MAX_TEXT_BYTES; number++) {
        const page = await pdf.getPage(number)
        const content = await page.getTextContent()
        let text = ''
        for (const item of content.items) {
          if (!('str' in item)) continue
          text += item.str + (item.hasEOL ? '\n' : ' ')
        }
        pages.push(text)
        length += text.length
        page.cleanup()
      }
      return finishExtracted(pages.join('\n\n'))
    } finally {
      void loadingTask.destroy()
    }
  } catch (err) {
    throw err instanceof AttachmentError ? err : new AttachmentError('unreadable')
  }
}

/**
 * Render the first `maxPages` pages of a PDF to image data URIs, each fitted
 * to MAX_IMAGE_EDGE. The fallback for scanned PDFs: with no text layer to
 * extract, the pages travel as images and a vision model reads them.
 */
export async function renderPdfPages(file: Blob, maxPages: number): Promise<{ images: string[]; totalPages: number }> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentError('too-large')
  try {
    const pdfjs = await loadPdfjs()
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    try {
      const pdf = await loadingTask.promise
      const images: string[] = []
      const lastPage = Math.min(pdf.numPages, maxPages)
      for (let number = 1; number <= lastPage; number++) {
        const page = await pdf.getPage(number)
        const base = page.getViewport({ scale: 1 })
        const { width } = fitWithin(base.width, base.height)
        const viewport = page.getViewport({ scale: width / base.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new AttachmentError('unreadable')
        // Scans are mostly transparent-free photos of paper; a white backdrop
        // keeps any transparent regions from encoding as black in JPEG.
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        // `canvas` is the newer render parameter, `canvasContext` the older one.
        const params = { canvas, canvasContext: ctx, viewport }
        await page.render(params as Parameters<typeof page.render>[0]).promise
        images.push(await encode(canvas, 'image/jpeg'))
        page.cleanup()
      }
      return { images, totalPages: pdf.numPages }
    } finally {
      void loadingTask.destroy()
    }
  } catch (err) {
    throw err instanceof AttachmentError ? err : new AttachmentError('unreadable')
  }
}
