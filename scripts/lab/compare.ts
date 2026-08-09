/**
 * Comparaison avant/après du laboratoire.
 *
 *   npx tsx scripts/lab/compare.ts data/lab/baseline-16.jsonl data/lab/apres-16.jsonl
 *
 * « Avant » est l'état d'après chantier 1 (économie durcie, sans sa
 * contrepartie), « après » est la roadmap complète (ossements, salles typées,
 * salle piégée, signal lent, salle de repos). La question : la roadmap a-t-elle
 * déplacé les courbes de survie dans le bon sens, profil par profil ?
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { RunResult } from './run.js'
import { aggregate, type ProfileStats } from './analyze.js'

async function load(file: string): Promise<RunResult[]> {
  const raw = await readFile(file, 'utf8')
  const out: RunResult[] = []
  for (const line of raw.split('\n')) if (line.trim()) out.push(JSON.parse(line) as RunResult)
  return out
}

const [fileAvant, fileApres] = process.argv.slice(2)
if (!fileAvant || !fileApres) {
  console.error('usage: compare.ts avant.jsonl apres.jsonl')
  process.exit(1)
}

const avant = aggregate(await load(fileAvant))
const apres = aggregate(await load(fileApres))
const avantBy = new Map(avant.map((s) => [s.name, s]))

interface Delta {
  name: string
  avant: ProfileStats | null
  apres: ProfileStats
  dMed: number
  dFirst: number
}

const deltas: Delta[] = apres.map((b) => {
  const a = avantBy.get(b.name) ?? null
  return {
    name: b.name,
    avant: a,
    apres: b,
    dMed: a ? b.floorMed - a.floorMed : 0,
    dFirst: a ? b.firstDeathMed - a.firstDeathMed : 0,
  }
})
deltas.sort((x, y) => y.dMed - x.dMed || y.apres.floorMed - x.apres.floorMed)

console.log('\n── Avant / après, par profil ──────────────────────────────────')
console.log('   étage médian (budget de morts épuisé) et 1re mort médiane.\n')
console.log('   profil                        méd. avant -> après   Δ     1re mort   Δ')
for (const d of deltas) {
  const a = d.avant
  console.log(
    `   ${d.name.padEnd(28)} ${String(a?.floorMed ?? '—').padStart(6)} -> ${String(d.apres.floorMed).padEnd(5)} ` +
      `${(d.dMed >= 0 ? '+' : '') + d.dMed}`.padEnd(8) +
      `${String(a?.firstDeathMed ?? '—').padStart(6)} -> ${String(d.apres.firstDeathMed).padEnd(3)} ` +
      `${(d.dFirst >= 0 ? '+' : '') + d.dFirst}`,
  )
}

const moved = deltas.filter((d) => d.avant)
const up = moved.filter((d) => d.dMed > 0).length
const same = moved.filter((d) => d.dMed === 0).length
const down = moved.filter((d) => d.dMed < 0).length
const meanD = moved.reduce((s, d) => s + d.dMed, 0) / Math.max(1, moved.length)
console.log(`\n   ${up} profils montent · ${same} inchangés · ${down} descendent — Δ médiane moyen ${meanD >= 0 ? '+' : ''}${meanD.toFixed(2)}`)

await writeFile(
  'data/lab/compare.json',
  JSON.stringify(
    deltas.map((d) => ({
      name: d.name,
      avant: d.avant
        ? { floorMed: d.avant.floorMed, p25: d.avant.floorP25, p75: d.avant.floorP75, firstDeathMed: d.avant.firstDeathMed, reach10: d.avant.reach10 }
        : null,
      apres: { floorMed: d.apres.floorMed, p25: d.apres.floorP25, p75: d.apres.floorP75, firstDeathMed: d.apres.firstDeathMed, reach10: d.apres.reach10 },
    })),
    null,
    1,
  ),
  'utf8',
)
console.log('\n  Détail écrit dans data/lab/compare.json')
