import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseImageResponse, requestImage, requestImageEdit, sniffImageMime, toDataUrl } from '@/lib/chat-image'

describe('sniffImageMime / toDataUrl', () => {
  it('names the type from the first bytes and defaults to PNG', () => {
    expect(sniffImageMime('/9j/4AAQ')).toBe('image/jpeg')
    expect(sniffImageMime('UklGRiQA')).toBe('image/webp')
    expect(sniffImageMime('R0lGODlh')).toBe('image/gif')
    expect(sniffImageMime('iVBORw0KGgo')).toBe('image/png')
    expect(sniffImageMime('????')).toBe('image/png')
    expect(toDataUrl('/9j/AAAA')).toBe('data:image/jpeg;base64,/9j/AAAA')
  })
})

describe('parseImageResponse', () => {
  it('returns the first base64 image with the model and provider that made it', () => {
    expect(parseImageResponse({ data: [{ url: 'https://x' }, { b64_json: 'AAAA' }], model: 'flux', provider: 'nvidia' }))
      .toEqual({ b64: 'AAAA', model: 'flux', provider: 'nvidia' })
  })

  it('throws the server message for an error body', () => {
    expect(() => parseImageResponse({ error: { message: 'quota exceeded' } })).toThrow('quota exceeded')
  })

  it('throws when there is no usable image (a bare link cannot be shown under the CSP)', () => {
    expect(() => parseImageResponse({ data: [{ url: 'https://x' }] })).toThrow('no image')
    expect(() => parseImageResponse({ data: [] })).toThrow('no image')
    expect(() => parseImageResponse(null)).toThrow('no image')
  })
})

describe('requestImage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the prompt asking for base64 and parses the answer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }], model: 'm', provider: 'p' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestImage({ base: '', headers: { Authorization: 'Bearer k' }, prompt: 'a cat' })
    expect(result).toEqual({ b64: 'QUJD', model: 'm', provider: 'p' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/images/generations')
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'a cat', n: 1, response_format: 'b64_json' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
  })

  it('surfaces the server error message, or the status when there is none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'no image providers' } }), { status: 502 })))
    await expect(requestImage({ base: '', headers: {}, prompt: 'x' })).rejects.toThrow('no image providers')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 503 })))
    await expect(requestImage({ base: '', headers: {}, prompt: 'x' })).rejects.toThrow('HTTP 503')
  })
})

describe('requestImageEdit', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uploads each picture as multipart and leaves Content-Type to the browser', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestImageEdit({
      base: '',
      headers: { Authorization: 'Bearer k' },
      prompt: 'make it blue',
      images: ['data:image/jpeg;base64,/9j/AAAA', 'data:image/png;base64,iVBORw0KGgo='],
    })
    expect(result.b64).toBe('QUJD')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/v1/images/edits')
    const form = init.body as FormData
    expect(form.get('prompt')).toBe('make it blue')
    expect(form.get('response_format')).toBe('b64_json')
    expect(form.getAll('image').map(file => (file as File).type)).toEqual(['image/jpeg', 'image/png'])
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})
