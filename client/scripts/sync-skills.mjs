// Refresh the bundled copies of the skill libraries the Playground offers.
//
//   node scripts/sync-skills.mjs                       # re-fetch every pinned commit
//   node scripts/sync-skills.mjs humanizer=main        # move one pin, then review the diff
//
// Each skill is written to public/skills/ as plain Markdown, with one index and
// one licence file per source, so skills ship with the client build, work
// offline and show up in git when they change. Nothing here runs at build time
// or at runtime.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkill } from './skill-front-matter.mjs'

// kind 'dir':    skills/<id>/SKILL.md, one skill per directory.
// kind 'single': one SKILL.md at the repository root.
const SOURCES = [
  { id: 'agent-skills', name: 'Agent Skills', author: 'Addy Osmani', repo: 'addyosmani/agent-skills', commit: 'aeac41d4d005999432bb7312f7ff06383a91d59d', kind: 'dir', path: 'skills' },
  { id: 'humanizer', name: 'Humanizer', author: 'Siqi Chen', repo: 'blader/humanizer', commit: '8c307f367c91bd974002f10f2be2965d642c13df', kind: 'single', path: 'SKILL.md' },
]

const overrides = Object.fromEntries(process.argv.slice(2).map(arg => arg.split('=')))
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/skills')

const api = async (url, accept = 'application/vnd.github+json') => {
  const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'freellmapi-sync-skills' } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res
}

async function fetchSource(source) {
  const ref = overrides[source.id] ?? source.commit
  const commit = (await (await api(`https://api.github.com/repos/${source.repo}/commits/${ref}`)).json()).sha
  const raw = (file) => `https://raw.githubusercontent.com/${source.repo}/${commit}/${file}`
  const entries = source.kind === 'dir'
    ? (await (await api(`https://api.github.com/repos/${source.repo}/contents/${source.path}?ref=${commit}`)).json())
        .filter(e => e.type === 'dir').map(e => ({ id: e.name, file: `${source.path}/${e.name}/SKILL.md` })).sort((a, b) => a.id.localeCompare(b.id))
    : [{ id: null, file: source.path }]

  const skills = []
  for (const entry of entries) {
    const text = await (await api(raw(entry.file), 'text/plain')).text()
    const parsed = parseSkill(entry.id ?? source.id, text)
    skills.push({ id: entry.id ?? parsed.name, ...parsed })
  }
  const license = await (await api(raw('LICENSE'), 'text/plain')).text()
  return { source, commit, skills, license }
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const index = { sources: [], skills: [] }
const seen = new Set()
for (const source of SOURCES) {
  const fetched = await fetchSource(source)
  await writeFile(path.join(out, `LICENSE-${source.id}`), fetched.license)
  index.sources.push({
    id: source.id, name: source.name, author: source.author, repo: `https://github.com/${source.repo}`,
    commit: fetched.commit, license: 'MIT',
  })
  for (const skill of fetched.skills) {
    if (seen.has(skill.id)) throw new Error(`duplicate skill id "${skill.id}" (from ${source.id})`)
    seen.add(skill.id)
    await writeFile(path.join(out, `${skill.id}.md`), skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`)
    // The rough estimate the Playground uses everywhere: about 4 characters a token.
    index.skills.push({ id: skill.id, name: skill.name, description: skill.description, source: source.id, tokens: Math.ceil(skill.body.length / 4) })
  }
  console.log(`${fetched.skills.length} from ${source.repo}@${fetched.commit.slice(0, 8)}`)
}

index.skills.sort((a, b) => a.id.localeCompare(b.id))
await writeFile(path.join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n')
console.log(index.skills.length, 'skills,', (await readdir(out)).length, 'files in', path.relative(process.cwd(), out))
