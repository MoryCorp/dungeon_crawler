/**
 * Orchestrateur du laboratoire : découpe une matrice de jobs en lots, un
 * processus par lot, et concatène les résultats.
 *
 *   npx tsx scripts/lab/swarm.ts baseline [graines_par_profil]
 *
 * La matrice baseline : 5 armes × 4 styles × {optimal, humanisé} en solo,
 * plus des équipes de 2 et 4 en style prudent — le style qu'un groupe d'amis
 * adopte naturellement. Les graines sont fixes et partagées entre tous les
 * profils : chaque profil affronte exactement les mêmes donjons, donc les
 * écarts entre profils ne doivent rien au tirage.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { LOOT_WEAPONS, STARTING_WEAPON } from '@dc/engine'
import { HUMAN, type Genome } from './brain.js'
import type { Job, RunResult } from './run.js'

export const WEAPONS_ALL = [STARTING_WEAPON, ...LOOT_WEAPONS]

/** Les quatre styles de la baseline. L'arme est injectée ensuite. */
export const STYLES: Record<string, Omit<Genome, 'weapon'>> = {
  bourrin: {
    objective: 'clear', kite: 0, dodge: 0.15, roll: 0.1, heartAt: 0.75,
    sprint: 'never', fleeAt: 0.08, engageCap: 99, patience: 1,
  },
  prudent: {
    objective: 'clear', kite: 1.3, dodge: 0.8, roll: 0.35, heartAt: 0.6,
    sprint: 'both', fleeAt: 0.35, engageCap: 3, patience: 0.8,
  },
  kite: {
    objective: 'balanced', kite: 2.4, dodge: 0.7, roll: 0.25, heartAt: 0.65,
    sprint: 'both', fleeAt: 0.3, engageCap: 4, patience: 0.5,
  },
  presse: {
    objective: 'rush', kite: 0.8, dodge: 0.5, roll: 0.4, heartAt: 0.5,
    sprint: 'travel', fleeAt: 0.2, engageCap: 2, patience: 0.1,
  },
}

/** Graines partagées : les mêmes donjons pour tout le monde. */
export function seeds(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 1_000_003 + i * 7919)
}

export function baselineJobs(seedCount: number): Job[] {
  const jobs: Job[] = []
  const pool = seeds(seedCount)

  for (const weapon of WEAPONS_ALL) {
    for (const [styleName, style] of Object.entries(STYLES)) {
      for (const human of [null, HUMAN]) {
        for (const seed of pool) {
          jobs.push({
            name: `${weapon}·${styleName}·${human ? 'humain' : 'optimal'}`,
            seed,
            genomes: [{ weapon, ...style }],
            human,
          })
        }
      }
    }
  }

  // Coop : des équipes mixtes en style prudent, la façon dont on joue entre
  // amis. Duo épée+arc, quatuor une arme de chaque famille.
  const duo = ['sword', 'bow']
  const squad = ['sword', 'axe', 'spear', 'bow']
  for (const [label, weapons] of [['duo', duo], ['quatuor', squad]] as const) {
    for (const human of [null, HUMAN]) {
      for (const seed of pool) {
        jobs.push({
          name: `${label}·prudent·${human ? 'humain' : 'optimal'}`,
          seed,
          genomes: weapons.map((weapon) => ({ weapon, ...STYLES.prudent! })),
          human,
        })
      }
    }
  }
  return jobs
}

/** Répartit les jobs sur N processus et rend tous les résultats. */
export async function runSwarm(jobs: Job[], tag: string): Promise<RunResult[]> {
  const workers = Math.max(1, cpus().length - 1)
  const dir = 'data/lab'
  await mkdir(dir, { recursive: true })

  // Mélange déterministe : sans lui, un worker hérite de tous les quatuors
  // (les runs les plus lents) et les autres se tournent les pouces.
  const shuffled = [...jobs]
  let h = 0x9e3779b9
  for (let i = shuffled.length - 1; i > 0; i--) {
    h = (Math.imul(h, 0x85ebca6b) + 0xc2b2ae35) >>> 0
    const j = h % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }

  const chunks: Job[][] = Array.from({ length: workers }, () => [])
  shuffled.forEach((job, i) => chunks[i % workers]!.push(job))

  const t0 = Date.now()
  let done = 0
  const outs: string[] = []
  await Promise.all(
    chunks.map(async (chunk, i) => {
      if (chunk.length === 0) return
      const jobsFile = `${dir}/.jobs-${tag}-${i}.json`
      const outFile = `${dir}/.out-${tag}-${i}.jsonl`
      await writeFile(jobsFile, JSON.stringify(chunk), 'utf8')
      await rm(outFile, { force: true })
      outs.push(outFile)
      await new Promise<void>((resolve, reject) => {
        const p = spawn(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'scripts/lab/run.ts', '--batch', jobsFile, '--out', outFile],
          { stdio: ['ignore', 'inherit', 'inherit'] },
        )
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i}: exit ${code}`))))
        p.on('error', reject)
      })
      done += chunk.length
      console.log(`  worker ${i} : ${chunk.length} runs finis (${done}/${jobs.length}, ${((Date.now() - t0) / 60000).toFixed(1)} min)`)
    }),
  )

  const results: RunResult[] = []
  for (const out of outs) {
    const raw = await readFile(out, 'utf8')
    for (const line of raw.split('\n')) {
      if (line.trim()) results.push(JSON.parse(line) as RunResult)
    }
  }
  await writeFile(`${dir}/${tag}.jsonl`, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  for (const out of outs) await rm(out, { force: true })
  for (let i = 0; i < workers; i++) await rm(`${dir}/.jobs-${tag}-${i}.json`, { force: true })
  console.log(`  ${results.length} runs -> data/lab/${tag}.jsonl en ${((Date.now() - t0) / 60000).toFixed(1)} min`)
  return results
}

// ------------------------------------------------------------------- CLI

const isMain = process.argv[1]?.endsWith('swarm.ts')
if (isMain) {
  const mode = process.argv[2] ?? 'baseline'
  const seedCount = Number(process.argv[3] ?? 16)
  if (mode !== 'baseline') {
    console.error('usage: swarm.ts baseline [graines]')
    process.exit(1)
  }
  const jobs = baselineJobs(seedCount)
  console.log(`${jobs.length} runs (${seedCount} graines par profil)`)
  await runSwarm(jobs, `baseline-${seedCount}`)
}
