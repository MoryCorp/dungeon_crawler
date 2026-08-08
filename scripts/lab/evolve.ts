/**
 * Évolution du génome, par arme : quel trait développer pour survivre ?
 *
 *   npx tsx scripts/lab/evolve.ts [tag] [générations] [graines]
 *
 * Une stratégie (1+λ) toute simple : un champion, λ mutants par génération,
 * le meilleur prend la place. La fitness est l'étage final moyen sur un panel
 * de graines fixe — le même pour tous les candidats, sinon on sélectionne la
 * chance et pas le style. Tous les candidats sont humanisés : la question
 * n'est pas « que peut faire une machine », mais « que peut faire un très bon
 * joueur » — le champion final est la borne haute humaine de chaque arme.
 *
 * C'est l'analogue direct des simulations d'évolution génétique qui ont
 * inspiré le laboratoire : on ne règle pas le bot à la main, on regarde ce
 * que la sélection retient. Si toutes les armes convergent vers le même
 * style, le jeu ne récompense qu'une façon de jouer — c'est une information
 * d'équilibrage qu'aucun réglage manuel n'aurait donnée.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { Rng } from '@dc/engine'
import { HUMAN, type Genome, type Objective, type SprintPolicy } from './brain.js'
import { runSwarm, seeds, STYLES, WEAPONS_ALL } from './swarm.js'
import type { Job } from './run.js'

const LAMBDA = 5

const OBJECTIVES: Objective[] = ['clear', 'rush', 'balanced']
const SPRINTS: SprintPolicy[] = ['travel', 'escape', 'both', 'never']

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Mutation : chaque trait bouge un peu, les traits discrets sautent rarement. */
function mutate(g: Genome, rng: Rng): Genome {
  const jitter = (v: number, span: number, lo: number, hi: number) =>
    clamp(v + (rng.next() * 2 - 1) * span, lo, hi)
  return {
    weapon: g.weapon,
    objective: rng.chance(0.15) ? OBJECTIVES[rng.int(OBJECTIVES.length)]! : g.objective,
    kite: jitter(g.kite, 0.6, 0, 3.5),
    dodge: jitter(g.dodge, 0.15, 0, 1),
    heartAt: jitter(g.heartAt, 0.12, 0.2, 0.95),
    sprint: rng.chance(0.15) ? SPRINTS[rng.int(SPRINTS.length)]! : g.sprint,
    fleeAt: jitter(g.fleeAt, 0.08, 0, 0.6),
    engageCap: clamp(Math.round(jitter(g.engageCap, 1.2, 1, 12)), 1, 12),
    patience: jitter(g.patience, 0.15, 0, 1),
  }
}

interface Champion {
  weapon: string
  genome: Genome
  fitness: number
  history: number[]
}

async function evolveWeapon(
  weapon: string,
  generations: number,
  pool: number[],
  tag: string,
): Promise<Champion> {
  const rng = new Rng(0xc0ffee ^ weapon.length * 2654435761)
  // On part du style prudent : le plus proche d'un joueur attentif.
  let champion: Genome = { weapon, ...STYLES.prudent! }
  let best = -1
  const history: number[] = []

  for (let gen = 0; gen < generations; gen++) {
    const candidates: Genome[] = [champion]
    for (let i = 0; i < LAMBDA; i++) candidates.push(mutate(champion, rng))

    const jobs: Job[] = []
    candidates.forEach((genome, ci) => {
      for (const seed of pool) {
        jobs.push({ name: `c${ci}`, seed, genomes: [genome], human: HUMAN })
      }
    })
    const results = await runSwarm(jobs, `.evo-${tag}-${weapon}-${gen}`)

    const scores = candidates.map((_, ci) => {
      const runs = results.filter((r) => r.name === `c${ci}`)
      return runs.reduce((s, r) => s + r.floor, 0) / Math.max(1, runs.length)
    })
    let bestIdx = 0
    for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[bestIdx]!) bestIdx = i
    // Le champion en titre garde sa place à égalité : pas de dérive neutre.
    if (scores[bestIdx]! > scores[0]!) champion = candidates[bestIdx]!
    best = Math.max(scores[bestIdx]!, scores[0]!)
    history.push(Math.round(best * 100) / 100)
    console.log(`  ${weapon} génération ${gen + 1}/${generations} : étage moyen ${best.toFixed(2)}`)
  }

  return { weapon, genome: champion, fitness: best, history }
}

const isMain = process.argv[1]?.endsWith('evolve.ts')
if (isMain) {
  const tag = process.argv[2] ?? 'base'
  const generations = Number(process.argv[3] ?? 12)
  const seedCount = Number(process.argv[4] ?? 6)
  const pool = seeds(seedCount)

  const champions: Champion[] = []
  for (const weapon of WEAPONS_ALL) {
    console.log(`\n=== Évolution : ${weapon} (${generations} générations × ${LAMBDA + 1} candidats × ${seedCount} graines)`)
    champions.push(await evolveWeapon(weapon, generations, pool, tag))
  }

  await mkdir('data/lab', { recursive: true })
  const out = `data/lab/champions-${tag}.json`
  await writeFile(out, JSON.stringify(champions, null, 1), 'utf8')
  console.log(`\nChampions écrits dans ${out}`)
  for (const c of champions) {
    console.log(
      `  ${c.weapon.padEnd(7)} étage moyen ${c.fitness.toFixed(2)} · ` +
        `${c.genome.objective} kite=${c.genome.kite.toFixed(1)} dodge=${c.genome.dodge.toFixed(2)} ` +
        `fuite@${c.genome.fleeAt.toFixed(2)} cap=${c.genome.engageCap} sprint=${c.genome.sprint}`,
    )
  }
}
