// Project memory: the brief and durable facts attached to a Playground project
// folder. Storage lives on /api/projects/:id/memory; this file holds the API
// wrappers and the pure helpers that build the injected system message and the
// extraction prompt. The server builds the same context for agent runs.

import { apiFetch } from './api'

export interface ProjectMemory {
  id: number
  content: string
  pinned: boolean
  source: 'manual' | 'auto'
  conversationId: number | null
  createdAt: number
  updatedAt: number
}

export interface ProjectMemoryState {
  instructions: string
  memories: ProjectMemory[]
}

export const MAX_INSTRUCTIONS_LEN = 4000
export const MAX_PROJECT_MEMORY_LEN = 500
/** Characters of facts injected per request; pinned first, then newest. */
export const MEMORY_CONTEXT_BUDGET = 4000

export function getProjectMemory(projectId: number): Promise<ProjectMemoryState> {
  return apiFetch<ProjectMemoryState>(`/api/projects/${projectId}/memory`)
}

export function saveProjectInstructions(projectId: number, instructions: string): Promise<{ instructions: string }> {
  return apiFetch(`/api/projects/${projectId}/instructions`, {
    method: 'PUT',
    body: JSON.stringify({ instructions }),
  })
}

export function addProjectMemory(
  projectId: number,
  memory: { content: string; pinned?: boolean; source?: 'manual' | 'auto'; conversationId?: number | null },
): Promise<ProjectMemory> {
  return apiFetch<ProjectMemory>(`/api/projects/${projectId}/memory`, {
    method: 'POST',
    body: JSON.stringify(memory),
  })
}

export function updateProjectMemory(
  projectId: number,
  memoryId: number,
  patch: { content?: string; pinned?: boolean },
): Promise<ProjectMemory> {
  return apiFetch<ProjectMemory>(`/api/projects/${projectId}/memory/${memoryId}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function deleteProjectMemory(projectId: number, memoryId: number): Promise<{ success: boolean }> {
  return apiFetch(`/api/projects/${projectId}/memory/${memoryId}`, { method: 'DELETE' })
}

/**
 * System message carrying a project's brief and facts, or '' when it has
 * neither. Mirrors server/src/services/project-memory.ts so Playground chats
 * and agent runs see the same context.
 */
export function projectContextMessage(
  projectName: string,
  state: ProjectMemoryState | undefined,
): string {
  if (!state) return ''
  const instructions = state.instructions.trim()
  const facts: string[] = []
  let used = 0
  // The server already orders pinned first, then newest.
  for (const memory of state.memories) {
    const line = memory.content.trim()
    if (!line || used + line.length > MEMORY_CONTEXT_BUDGET) continue
    facts.push(line)
    used += line.length
  }
  if (!instructions && facts.length === 0) return ''

  const parts = [
    `This chat belongs to the project "${projectName}". Use the project context below to stay consistent with earlier work in this project.`,
  ]
  if (instructions) {
    parts.push('', 'Project instructions (from the user, follow them):', instructions)
  }
  if (facts.length > 0) {
    parts.push(
      '',
      'Project memory (notes saved from earlier work in this project; use when relevant, do not recite unprompted, and trust the user\'s current message over a note if they conflict):',
      ...facts.map(f => `- ${f}`),
    )
  }
  return parts.join('\n')
}

/** Prompt that asks the model for new project-specific durable facts only. */
export function projectMemoryExtractPrompt(
  projectName: string,
  existing: readonly { content: string }[],
  latestExchange: { user: string; assistant: string },
): string {
  const existingBlock = existing.length === 0
    ? '(none yet)'
    : existing.map(m => `- ${m.content}`).join('\n')

  return [
    `You maintain the long-term memory of a project called "${projectName}".`,
    'Given the latest exchange and the project memories already stored, return ONLY a JSON array of NEW facts that will help in future chats about this project.',
    'Worth keeping: decisions made and why, requirements and constraints, architecture and tooling choices, names of people/systems/files, conventions, current status, open problems, the user\'s preferences for this project.',
    'Skip: general chit-chat, facts about the user unrelated to this project, one-off questions, anything already covered below, secrets (passwords, API keys, tokens).',
    'If a new fact replaces an older one (a changed decision), state the new fact in full so it can supersede the old one.',
    'Each item: one short self-contained sentence, max 200 characters.',
    'If nothing new is worth remembering, return [].',
    '',
    'Existing project memories:',
    existingBlock,
    '',
    'Latest user message:',
    latestExchange.user.slice(0, 4000),
    '',
    'Latest assistant reply:',
    latestExchange.assistant.slice(0, 4000),
  ].join('\n')
}
