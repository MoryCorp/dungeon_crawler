/**
 * Agrégation des résultats du laboratoire.
 *
 *   npx tsx scripts/lab/analyze.ts data/lab/baseline-16.jsonl
 *
 * La question à laquelle tout répond : la difficulté est-elle humainement
 * jouable ? L'étalon, fixé par Amaury : un bon joueur solo atteint l'étage 10
 * en médiane, un joueur moyen meurt vers 5-7. Le « bon joueur » du labo est le
 * meilleur profil humanisé ; l'écart optimal/humanisé dit combien le jeu
 * pardonne l'imperfection.
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { RunResult } from './run.js'

export interface ProfileStats {
  name: string
  runs: number
  /** Étage de fin de run (budget de morts épuisé). */
  floorMed: number
  floorP25: number
  floorP75: number
  /** Étage de la première mort (les runs sans mort comptent comme plafond+1). */
  firstDeathMed: number
  /** Part des runs qui atteignent l'étage 10. */
  reach10: number
  deathsPerFloor: number
  /** Qui tue, cumulé sur tous les runs du profil. */
  downedBy: Record<string, number>
  downTerrain: Record<string, number>
  stalled: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length))
  return sorted[i]!
}

export function aggregate(results: RunResult[]): ProfileStats[] {
  const byName = new Map<string, RunResult[]>()
  for (const r of results) {
    const list = byName.get(r.name) ?? []
    list.push(r)
    byName.set(r.name, list)
  }

  const out: ProfileStats[] = []
  for (const [name, runs] of byName) {
    const floors = runs.map((r) => r.floor).sort((a, b) => a - b)
    // Sans mort, la première mort n'existe pas : on compte l'étage final + 1,
    // sinon les meilleurs runs tireraient la médiane vers le bas.
    const firsts = runs
      .map((r) => (r.firstDeathFloor > 0 ? r.firstDeathFloor : r.floor + 1))
      .sort((a, b) => a - b)
    const downedBy: Record<string, number> = {}
    const downTerrain: Record<string, number> = {}
    let deaths = 0
    let floorSum = 0
    for (const r of runs) {
      deaths += r.deaths
      floorSum += r.floor
      for (const [k, v] of Object.entries(r.downedBy)) downedBy[k] = (downedBy[k] ?? 0) + v
      for (const [k, v] of Object.entries(r.downTerrain)) downTerrain[k] = (downTerrain[k] ?? 0) + v
    }
    out.push({
      name,
      runs: runs.length,
      floorMed: quantile(floors, 0.5),
      floorP25: quantile(floors, 0.25),
      floorP75: quantile(floors, 0.75),
      firstDeathMed: quantile(firsts, 0.5),
      reach10: runs.filter((r) => r.floor >= 10).length / runs.length,
      deathsPerFloor: floorSum > 0 ? deaths / floorSum : 0,
      downedBy,
      downTerrain,
      stalled: runs.filter((r) => r.ended === 'stalled').length,
    })
  }
  out.sort((a, b) => b.floorMed - a.floorMed || b.floorP75 - a.floorP75)
  return out
}

function topKillers(tally: Record<string, number>, n = 3): string {
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((s, [, v]) => s + v, 0)
  if (total === 0) return '—'
  return entries
    .slice(0, n)
    .map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`)
    .join(' · ')
}

export function printReport(stats: ProfileStats[], target = 10): void {
  console.log('\n── Courbes de survie par profil ───────────────────────────────')
  console.log('  étage final = budget de morts épuisé (6 par joueur).\n')
  console.log('   profil                        runs   étage (p25-méd-p75)   1re mort   ≥10   morts/étage')
  for (const s of stats) {
    console.log(
      `   ${s.name.padEnd(28)} ${String(s.runs).padStart(5)}   ` +
        `${String(s.floorP25).padStart(4)} - ${String(s.floorMed).padStart(2)} - ${String(s.floorP75).padEnd(2)}     ` +
        `${String(s.firstDeathMed).padStart(6)}   ` +
        `${Math.round(s.reach10 * 100).toString().padStart(3)}%   ` +
        `${s.deathsPerFloor.toFixed(2).padStart(8)}`,
    )
  }

  console.log('\n── Qui tue, par profil (top 3) ────────────────────────────────')
  for (const s of stats) {
    console.log(`   ${s.name.padEnd(28)} ${topKillers(s.downedBy)}`)
  }

  // Le verdict contre l'étalon.
  const humans = stats.filter((s) => s.name.endsWith('humain') && !s.name.startsWith('duo') && !s.name.startsWith('quatuor'))
  const best = humans[0]
  console.log('\n── Verdict ────────────────────────────────────────────────────')
  if (!best) {
    console.log('  Aucun profil humanisé dans le lot.')
    return
  }
  console.log(`  Étalon : un bon joueur solo atteint l'étage ${target} en médiane.`)
  console.log(`  Meilleur profil humanisé : ${best.name} — médiane ${best.floorMed}, ${Math.round(best.reach10 * 100)} % des runs à l'étage ${target}.`)
  if (best.floorMed >= target) {
    console.log('  → La difficulté est réalisable par un bon joueur. Reste à vérifier le plaisir.')
  } else if (best.floorMed >= target * 0.6) {
    console.log(`  → En dessous de l'étalon : le mur se situe vers l'étage ${best.floorMed}.`)
  } else {
    console.log(`  → Loin de l'étalon : même le meilleur style humanisé meurt vers l'étage ${best.floorMed}.`)
    console.log('    La difficulté actuelle est un mur, pas une pente.')
  }
}

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1]?.endsWith('analyze.ts')
if (isMain) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: analyze.ts resultats.jsonl [resultats2.jsonl…]')
    process.exit(1)
  }
  const results: RunResult[] = []
  for (const f of process.argv.slice(2)) {
    const raw = await readFile(f, 'utf8')
    for (const line of raw.split('\n')) if (line.trim()) results.push(JSON.parse(line) as RunResult)
  }
  const stats = aggregate(results)
  printReport(stats)
  const summaryPath = file.replace(/\.jsonl$/, '-resume.json')
  await writeFile(summaryPath, JSON.stringify(stats, null, 1), 'utf8')
  console.log(`\n  Résumé écrit dans ${summaryPath}`)
}
