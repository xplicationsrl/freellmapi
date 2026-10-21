// Refresh the bundled copy of the Agent Skills library the Playground offers
// (https://github.com/addyosmani/agent-skills, MIT).
//
//   node scripts/sync-skills.mjs            # re-fetch the pinned commit
//   node scripts/sync-skills.mjs <sha|main> # move the pin, then review the diff
//
// The skills are written to public/skills/ as plain Markdown plus an index, so
// they ship with the client build, work offline and show up in git when they
// change. Nothing here runs at build time or at runtime.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'addyosmani/agent-skills'
const PINNED_COMMIT = 'aeac41d4d005999432bb7312f7ff06383a91d59d'
const ref = process.argv[2] ?? PINNED_COMMIT
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/skills')

const api = async (url, accept = 'application/vnd.github+json') => {
  const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'freellmapi-sync-skills' } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res
}

const commit = (await (await api(`https://api.github.com/repos/${REPO}/commits/${ref}`)).json()).sha
const raw = (file) => `https://raw.githubusercontent.com/${REPO}/${commit}/${file}`
const listing = await (await api(`https://api.github.com/repos/${REPO}/contents/skills?ref=${commit}`)).json()
const ids = listing.filter(e => e.type === 'dir').map(e => e.name).sort()

// "---\nname: x\ndescription: y\n---\nbody" -> { name, description, body }
function parseSkill(id, text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${id}: no front matter`)
  const field = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1].trim().replace(/^["']|["']$/g, '')
  const name = field('name')
  const description = field('description')
  if (!name || !description) throw new Error(`${id}: front matter lacks name or description`)
  return { name, description, body: match[2].replace(/^\s+/, '') }
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const skills = []
for (const id of ids) {
  const text = await (await api(raw(`skills/${id}/SKILL.md`), 'text/plain')).text()
  const { name, description, body } = parseSkill(id, text)
  await writeFile(path.join(out, `${id}.md`), body.endsWith('\n') ? body : `${body}\n`)
  // Same rough estimate the Playground uses everywhere: about 4 characters a token.
  skills.push({ id, name, description, tokens: Math.ceil(body.length / 4) })
}

await writeFile(path.join(out, 'LICENSE'), await (await api(raw('LICENSE'), 'text/plain')).text())
await writeFile(path.join(out, 'index.json'), JSON.stringify({
  source: { repo: `https://github.com/${REPO}`, commit, license: 'MIT', author: 'Addy Osmani' },
  skills,
}, null, 2) + '\n')

console.log(`${skills.length} skills from ${REPO}@${commit.slice(0, 8)} -> ${path.relative(process.cwd(), out)}`)
console.log((await readdir(out)).length, 'files')
