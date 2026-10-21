// Reads the front matter of a SKILL.md. Kept apart from sync-skills.mjs so it
// can be unit-tested without that script fetching anything.

/**
 * "---\nname: x\ndescription: y\n---\nbody" -> { name, description, body }.
 * A description may be one line or a YAML block scalar ("|" or ">"); either way
 * it comes back as a single line.
 */
export function parseSkill(id, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${id}: no front matter`)
  const lines = match[1].split(/\r?\n/)
  const field = (key) => {
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at === -1) return undefined
    const first = lines[at].slice(key.length + 1).trim()
    if (!/^[|>][+-]?$/.test(first)) return first.replace(/^["']|["']$/g, '')
    const block = []
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== '' && !/^\s/.test(line)) break
      block.push(line.trim())
    }
    return block.filter(Boolean).join(' ')
  }
  const name = field('name')
  const description = field('description')
  if (!name || !description) throw new Error(`${id}: front matter lacks name or description`)
  return { name, description, body: match[2].replace(/^\s+/, '') }
}
