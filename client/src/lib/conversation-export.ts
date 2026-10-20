// A saved Playground conversation as a Markdown document the person can keep,
// share or paste elsewhere. Pure functions here; the one DOM call (the
// download) is at the bottom.

import type { ChatMessage, Conversation } from '@/lib/playground-conversations'

export interface ExportLabels {
  you: string
  assistant: string
}

const FEEDBACK_MARK = { up: '👍', down: '👎' } as const

function speaker(message: ChatMessage, labels: ExportLabels): string {
  if (message.role === 'user') return labels.you
  const via = [message.meta?.platform, message.meta?.model].filter(Boolean).join('/')
  return via ? `${labels.assistant} · ${via}` : labels.assistant
}

function messageBody(message: ChatMessage): string {
  const parts: string[] = []
  if (message.images?.length) parts.push(message.images.map(() => '*[image]*').join(' '))
  if (message.isError) parts.push(`> ⚠ ${message.content.replace(/\n/g, '\n> ')}`)
  else if (message.content.trim()) parts.push(message.content.trim())
  if (message.feedback) parts.push(FEEDBACK_MARK[message.feedback])
  return parts.join('\n\n')
}

/** `YYYY-MM-DD` in local time. */
export function exportDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function conversationToMarkdown(conversation: Pick<Conversation, 'title' | 'model' | 'messages'>, labels: ExportLabels, now: Date = new Date()): string {
  const header = [`# ${conversation.title.trim() || labels.assistant}`]
  const facts = [conversation.model ? `model: ${conversation.model}` : '', exportDate(now)].filter(Boolean)
  header.push(`> ${facts.join(' · ')}`)
  const sections = conversation.messages
    .map(message => ({ heading: speaker(message, labels), body: messageBody(message) }))
    .filter(section => section.body)
    .map(section => `## ${section.heading}\n\n${section.body}`)
  return [header.join('\n\n'), ...sections].join('\n\n') + '\n'
}

/** A safe file name from the title: ASCII, dashes, with the date and extension. */
export function exportFilename(title: string, now: Date = new Date()): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return `${slug || 'conversation'}-${exportDate(now)}.md`
}

/** Hand `text` to the browser as a file download. */
export function downloadTextFile(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
