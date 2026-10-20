// Image generation from the Playground: one request to /v1/images/generations,
// and the result made small enough to live in a saved conversation.
//
// The server caps a stored conversation at 2 MB and the whole transcript is
// saved after every exchange, so a 1024 px PNG (about 2 MB of base64 by itself)
// would make the conversation unsaveable. The browser therefore re-encodes each
// generated image as a JPEG of a few hundred kB before keeping it. That copy is
// what is shown, stored and offered for download.

import { dataUrlBytes, fitWithin } from '@/lib/attachments'

/** Target size for one stored generated image. */
export const GENERATED_IMAGE_MAX_BYTES = 350_000
/** Longest edge to try first; later attempts step down. */
const EDGES = [1024, 800, 640]
const QUALITIES = [0.85, 0.7, 0.55]

/** The image type a base64 payload declares in its first bytes (PNG when unknown). */
export function sniffImageMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('UklGR')) return 'image/webp'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  return 'image/png'
}

export function toDataUrl(b64: string): string {
  return `data:${sniffImageMime(b64)};base64,${b64}`
}

export interface ImageResult {
  b64: string
  model?: string
  provider?: string
}

/** Pull the first image out of an /v1/images/generations response, or throw with the server's message. */
export function parseImageResponse(body: unknown): ImageResult {
  const response = body as {
    data?: { b64_json?: unknown; url?: unknown }[]
    model?: unknown
    provider?: unknown
    error?: { message?: unknown }
  } | null
  if (response?.error?.message) throw new Error(String(response.error.message))
  const b64 = response?.data?.find(item => typeof item?.b64_json === 'string' && item.b64_json)?.b64_json
  if (typeof b64 !== 'string') throw new Error('The provider returned no image.')
  return {
    b64,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
  }
}

/** Ask for one image. Resolves with the base64 payload; rejects with the server's message. */
export async function requestImage(opts: {
  base: string
  headers: Record<string, string>
  prompt: string
  signal?: AbortSignal
}): Promise<ImageResult> {
  const res = await fetch(`${opts.base}/v1/images/generations`, {
    method: 'POST',
    headers: opts.headers,
    body: JSON.stringify({ prompt: opts.prompt, n: 1, response_format: 'b64_json' }),
    signal: opts.signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message
    throw new Error(message ?? `HTTP ${res.status}`)
  }
  return parseImageResponse(body)
}

function b64ToBlob(b64: string, type: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * Re-encode a generated image as a JPEG under GENERATED_IMAGE_MAX_BYTES,
 * lowering quality and then size until it fits. Browser-only (canvas). An
 * unreadable image rejects, which the caller shows as a failed generation.
 */
export async function shrinkGeneratedImage(b64: string): Promise<string> {
  const bitmap = await createImageBitmap(b64ToBlob(b64, sniffImageMime(b64)))
  try {
    let last = ''
    for (const edge of EDGES) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, edge)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is not available.')
      // JPEG has no alpha: paint white first so transparency is not black.
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      for (const quality of QUALITIES) {
        last = canvas.toDataURL('image/jpeg', quality)
        if (dataUrlBytes(last) <= GENERATED_IMAGE_MAX_BYTES) return last
      }
    }
    return last
  } finally {
    bitmap.close?.()
  }
}

/** Hand a data URI to the browser as a file download. */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}
