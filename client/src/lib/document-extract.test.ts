// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { deflateRawSync } from 'node:zlib'
import { describe, it, expect } from 'vitest'
import { AttachmentError, MAX_TEXT_BYTES } from '@/lib/attachments'
import { MAX_DOCUMENT_BYTES, docxXmlToText, extractDocxText, finishExtracted } from '@/lib/document-extract'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`

describe('finishExtracted', () => {
  it('normalises line endings and blank runs', () => {
    expect(finishExtracted('a  \r\n\r\n\r\n\r\nb\t\n')).toEqual({ text: 'a\n\nb', truncated: false })
  })

  it('returns null when there is nothing readable (e.g. a scanned PDF)', () => {
    expect(finishExtracted(' \n\t \n')).toBeNull()
  })

  it('cuts at the cap and says so', () => {
    const result = finishExtracted('x'.repeat(50), 10)
    expect(result?.truncated).toBe(true)
    expect(result?.text.startsWith('x'.repeat(10))).toBe(true)
    expect(result?.text).toContain('truncated')
  })
})

describe('docxXmlToText', () => {
  it('turns paragraphs, tabs and breaks into text', () => {
    const xml = doc(`
      <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>world</w:t></w:r></w:p>
      <w:p><w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p>`)
    expect(docxXmlToText(xml)).toBe('Hello\tworld\nline one\nline two')
  })

  it('reads text inside hyperlinks and keeps romanian diacritics', () => {
    const xml = doc('<w:p><w:hyperlink><w:r><w:t>Știri și mâncare</w:t></w:r></w:hyperlink></w:p>')
    expect(docxXmlToText(xml)).toBe('Știri și mâncare')
  })

  it('flattens tables to tab-separated rows', () => {
    const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`
    const xml = doc(`<w:tbl><w:tr>${cell('A')}${cell('B')}</w:tr><w:tr>${cell('C')}${cell('D')}</w:tr></w:tbl>`)
    expect(docxXmlToText(xml)).toBe('A\tB\nC\tD')
  })

  it('ignores tracked deletions and text boxes inside a paragraph', () => {
    const xml = doc(`<w:p><w:r><w:t>keep</w:t></w:r><w:del><w:r><w:t>gone</w:t></w:r></w:del>
      <w:r><w:txbxContent><w:p><w:r><w:t>box</w:t></w:r></w:p></w:txbxContent></w:r></w:p>`)
    expect(docxXmlToText(xml)).toBe('keep')
  })

  it('rejects XML that is not a Word document', () => {
    expect(() => docxXmlToText('<not-xml')).toThrow(AttachmentError)
    expect(() => docxXmlToText('<root/>')).toThrow(AttachmentError)
  })
})

// A real zip container, built by hand, so the whole extractDocxText path runs.
// Node's Blob and zlib are used because jsdom's Blob lacks stream()/arrayBuffer();
// real browsers have both.
async function buildZip(files: Record<string, string>, deflate: boolean): Promise<Blob> {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = enc.encode(content)
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw
    const nameBytes = enc.encode(name)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, deflate ? 8 : 0, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const entry = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(entry.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, deflate ? 8 : 0, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    parts.push(local, data)
    central.push(entry)
    offset += local.length + data.length
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  return new NodeBlob([...parts, ...central, eocd]) as unknown as Blob
}

describe('extractDocxText', () => {
  const body = doc('<w:p><w:r><w:t>Contract nr. 5</w:t></w:r></w:p><w:p><w:r><w:t>Semnat de părți</w:t></w:r></w:p>')

  it.each([true, false])('reads word/document.xml from a zip (deflate=%s)', async (deflate) => {
    const blob = await buildZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': body }, deflate)
    expect(await extractDocxText(blob)).toEqual({ text: 'Contract nr. 5\nSemnat de părți', truncated: false })
  })

  it('returns null for a document with no text', async () => {
    const blob = await buildZip({ 'word/document.xml': doc('<w:p/>') }, true)
    expect(await extractDocxText(blob)).toBeNull()
  })

  it('reports a zip without word/document.xml as unreadable', async () => {
    const blob = await buildZip({ 'other.xml': '<a/>' }, false)
    await expect(extractDocxText(blob)).rejects.toMatchObject({ reason: 'unreadable' })
  })

  it('reports a non-zip file as unreadable', async () => {
    await expect(extractDocxText(new Blob(['just some text, not a zip file at all'])))
      .rejects.toMatchObject({ reason: 'unreadable' })
  })

  it('refuses files over the size limit before reading them', async () => {
    const big = { size: MAX_DOCUMENT_BYTES + 1, arrayBuffer: () => Promise.reject(new Error('must not read')) } as unknown as Blob
    await expect(extractDocxText(big)).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('applies the shared text cap', async () => {
    const long = doc(`<w:p><w:r><w:t>${'a'.repeat(MAX_TEXT_BYTES + 500)}</w:t></w:r></w:p>`)
    const result = await extractDocxText(await buildZip({ 'word/document.xml': long }, true))
    expect(result?.truncated).toBe(true)
  })
})
