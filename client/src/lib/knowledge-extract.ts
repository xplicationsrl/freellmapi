// Turn an uploaded file into pages of plain text for the knowledge base. Runs
// in the browser: the server ships no PDF or Word parser, and the text layer is
// all that is indexed (a scanned PDF has none and is reported, not indexed).

import { AttachmentError } from '@/lib/attachments'
import { extractDocxText, MAX_DOCUMENT_BYTES } from '@/lib/document-extract'

export const KNOWLEDGE_MAX_PDF_PAGES = 400

export interface KnowledgeUpload {
  name: string
  mimeType: string
  text?: string
  pages?: string[]
}

export type KnowledgeKind = 'text' | 'markdown' | 'pdf' | 'docx'

export function knowledgeKind(file: { name: string; type: string }): KnowledgeKind | null {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.docx')) return 'docx'
  if (name.endsWith('.md') || name.endsWith('.markdown') || file.type === 'text/markdown') return 'markdown'
  if (name.endsWith('.txt') || file.type === 'text/plain') return 'text'
  return null
}

const MIME: Record<KnowledgeKind, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

async function extractPdfPages(file: Blob): Promise<string[]> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new AttachmentError('too-large')
  try {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ])
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    try {
      const pdf = await task.promise
      const pages: string[] = []
      const last = Math.min(pdf.numPages, KNOWLEDGE_MAX_PDF_PAGES)
      for (let n = 1; n <= last; n++) {
        const page = await pdf.getPage(n)
        const content = await page.getTextContent()
        let text = ''
        for (const item of content.items) {
          if (!('str' in item)) continue
          text += item.str + (item.hasEOL ? '\n' : ' ')
        }
        pages.push(text)
        page.cleanup()
      }
      return pages
    } finally {
      void task.destroy()
    }
  } catch (err) {
    throw err instanceof AttachmentError ? err : new AttachmentError('unreadable')
  }
}

/** Read a file into the upload body the Knowledge API takes. */
export async function prepareKnowledgeUpload(file: File): Promise<KnowledgeUpload> {
  const kind = knowledgeKind(file)
  if (!kind) throw new Error('Use a .txt, .md, .pdf or .docx file')
  const mimeType = MIME[kind]
  if (kind === 'text' || kind === 'markdown') {
    return { name: file.name, mimeType, text: await file.text() }
  }
  if (kind === 'docx') {
    const doc = await extractDocxText(file)
    if (!doc) throw new Error('No readable text in this document')
    return { name: file.name, mimeType, pages: [doc.text] }
  }
  const pages = await extractPdfPages(file)
  if (!pages.some(p => p.trim())) {
    throw new Error('This PDF has no text layer (scanned PDFs are not supported yet)')
  }
  return { name: file.name, mimeType, pages }
}
