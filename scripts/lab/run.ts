/**
 * Exécute des runs de laboratoire.
 *
 * Deux usages :
 *   npx tsx scripts/lab/run.ts --batch jobs.json --out resultats.jsonl
 *   npx tsx scripts/lab/run.ts --demo   (un run bavard pour vérifier le cerveau)
 *
 * Un job décrit une équipe (1, 2 ou 4 génomes), une graine et une éventuelle
 * humanisation. La sortie est une ligne JSON compacte par run — le résumé, pas
 * la télémétrie complète : à mille runs, c'est le résumé qu'on agrège.
 *
 * Fin de run : le budget de morts est épuisé (6 par joueur — au-delà, un
 * groupe humain aurait abandonné), le plafond d'étages est atteint, ou
 * l'équipe piétine (étage trop long). L'« étage atteint » est celui où le
 * budget s'épuise ; la « première mort » est l'autre lecture, plus proche du
 * ressenti d'un joueur qui considère sa run finie dès qu'il tombe.
 */
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  TICK_RATE,
  addPlayer,
  createGame,
  step,
  type GameState,
  type PlayerInput,
} from '@dc/engine'
import { terrainAt } from '../../apps/server/src/telemetry.js'
import { Brain, HUMAN, type Genome, type Humanization } from './brain.js'

export interface Job {
  /** Nom du profil, ex. "dague·kite·humain". Sert de clé d'agrégation. */
  name: string
  seed: number
  genomes: Genome[]
  human: Humanization | null
}

export interface RunResult {
  name: string
  seed: number
  players: number
  weapons: string[]
  human: boolean
  /** Étage où le run s'est terminé. */
  floor: number
  /** Étage de la première mort (0 = personne n'est mort). */
  firstDeathFloor: number
  deaths: number
  downs: number
  /** Étage de chaque mort, dans l'ordre. */
  deathFloors: number[]
  /** Qui a mis à terre, cumulé : espèce -> compte. */
  downedBy: Record<string, number>
  /** Terrain des mises à terre : couloir/petite/grande -> compte. */
  downTerrain: Record<string, number>
  /** Monstres tués. */
  kills: number
  /** Vagues livrées par la Directrice. */
  hordes: number
  /** Distance moyenne de livraison (ancre → cible), en tuiles. */
  hordeDist: number
  /** Durée simulée, en secondes. */
  seconds: number
  ended: 'deaths' | 'cap' | 'stalled'
}

const MAX_FLOORS = 20
const DEATHS_PER_PLAYER = 6
/**
 * Coincement : plus aucun événement (tué, descente, mort) depuis 90 s. Un
 * plafond de temps par étage semblait plus simple, mais il amputait les
 * profils lents — une dague prudente met plus de quatre minutes à nettoyer un
 * étage sans être coincée le moins du monde, et on lui comptait l'étage du
 * blocage au lieu de l'étage où elle serait vraiment morte.
 */
const WEDGE_TICKS = TICK_RATE * 90
const MAX_TICKS_TOTAL = TICK_RATE * 60 * 45

export function runOne(job: Job): RunResult {
  const state = createGame(job.seed)
  const brains: Brain[] = []
  const lastHitBy = new Map<string, string>()

  job.genomes.forEach((g, i) => {
    const id = `bot${i}`
    const actor = addPlayer(state, id, `${g.weapon}-${i}`)
    actor.weapon = g.weapon
    brains.push(new Brain(id, g, job.human, job.seed + i * 7919))
  })

  const deathBudget = DEATHS_PER_PLAYER * job.genomes.length
  const result: RunResult = {
    name: job.name,
    seed: job.seed,
    players: job.genomes.length,
    weapons: job.genomes.map((g) => g.weapon),
    human: job.human !== null,
    floor: 1,
    firstDeathFloor: 0,
    deaths: 0,
    downs: 0,
    deathFloors: [],
    downedBy: {},
    downTerrain: {},
    kills: 0,
    hordes: 0,
    hordeDist: 0,
    seconds: 0,
    ended: 'cap',
  }

  let lastEventTick = 0
  let totalTicks = 0
  let hordeDistSum = 0

  while (totalTicks < MAX_TICKS_TOTAL) {
    const inputs: Record<string, PlayerInput> = {}
    for (const b of brains) inputs[b.id] = b.tick(state)

    step(state, inputs)
    totalTicks++

    for (const ev of state.events) {
      if (ev.t === 'hit' && ev.toSpecies === 'hero') {
        lastHitBy.set(ev.to, ev.fromSpecies || 'inconnu')
      } else if (ev.t === 'downed') {
        result.downs++
        const by = lastHitBy.get(ev.id) ?? 'inconnu'
        result.downedBy[by] = (result.downedBy[by] ?? 0) + 1
        const terr = terrainAt(state, ev.x, ev.y)
        result.downTerrain[terr] = (result.downTerrain[terr] ?? 0) + 1
      } else if (ev.t === 'death') {
        lastEventTick = totalTicks
        if (ev.kind === 'player') {
          result.deaths++
          result.deathFloors.push(state.floor)
          if (result.firstDeathFloor === 0) result.firstDeathFloor = state.floor
        } else {
          result.kills++
        }
      } else if (ev.t === 'descend') {
        lastEventTick = totalTicks
      } else if (ev.t === 'horde') {
        result.hordes++
        hordeDistSum += ev.dist
      }
    }

    result.floor = state.floor

    if (result.deaths >= deathBudget) {
      result.ended = 'deaths'
      break
    }
    if (state.floor > MAX_FLOORS) {
      result.ended = 'cap'
      break
    }
    if (totalTicks - lastEventTick > WEDGE_TICKS) {
      result.ended = 'stalled'
      break
    }
  }

  result.seconds = Math.round(totalTicks / TICK_RATE)
  result.hordeDist = result.hordes > 0 ? Math.round((hordeDistSum / result.hordes) * 10) / 10 : 0
  return result
}

// ------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--demo')) {
    const genome: Genome = {
      weapon: 'sword', objective: 'clear', kite: 1.2, dodge: 0.8,
      heartAt: 0.6, sprint: 'both', fleeAt: 0.35, engageCap: 3, patience: 0.8,
    }
    for (const human of [null, HUMAN]) {
      const r = runOne({ name: human ? 'démo·humain' : 'démo·optimal', seed: 20260808, genomes: [genome], human })
      console.log(JSON.stringify(r))
    }
    return
  }

  const batchAt = argv.indexOf('--batch')
  const outAt = argv.indexOf('--out')
  if (batchAt < 0 || outAt < 0) {
    console.error('usage: run.ts --batch jobs.json --out resultats.jsonl | --demo')
    process.exit(1)
  }
  const jobs = JSON.parse(await readFile(argv[batchAt + 1]!, 'utf8')) as Job[]
  const out = argv[outAt + 1]!
  await mkdir(dirname(out), { recursive: true })

  for (const job of jobs) {
    const r = runOne(job)
    await appendFile(out, JSON.stringify(r) + '\n', 'utf8')
  }
}

const isMain = process.argv[1]?.endsWith('run.ts')
if (isMain) await main()
