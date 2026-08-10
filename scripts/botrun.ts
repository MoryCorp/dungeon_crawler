/**
 * Simulation d'une descente jouée sans réfléchir, en deux stratégies :
 *
 *   npx tsx scripts/botrun.ts [étages] [graine] [brute|rush]
 *
 * - `brute` (défaut) : foncer sur le monstre le plus proche et bourriner, sans
 *   jamais esquiver ni reculer. L'étage finit toujours nettoyé.
 * - `rush` : ignorer tout, aller chercher la clé, descendre. C'est la façon de
 *   jouer qu'on a mesurée en vrai — 60 % de l'étage laissé derrière — et donc
 *   celle qui teste si laisser des monstres en vie coûte quelque chose.
 *
 * C'est le garde-fou d'équilibrage du projet. Si l'une de ces stratégies
 * traverse dix étages sans jamais descendre sous 70 % de PV, le jeu est trop
 * facile — pas parce qu'un chiffre est mal réglé, mais parce qu'aucune décision
 * n'est demandée au joueur. Le rapport de fin dit à quel étage la bêtise cesse
 * de suffire.
 *
 * Aucun réseau, aucun serveur : uniquement l'engine, donc c'est reproductible
 * et ça tourne en quelques secondes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MAP_H,
  MAP_W,
  PICKUP_RANGE,
  TICK_RATE,
  addPlayer,
  chestPrice,
  createGame,
  isWalkable,
  step,
  type Actor,
  type GameState,
  type PlayerInput,
} from '@dc/engine'
import { RunTelemetry, floorSummary } from '../apps/server/src/telemetry.js'

const floorsToRun = Number(process.argv[2] ?? 10)
const seed = Number(process.argv[3] ?? 20260808)
const mode = process.argv[4] === 'rush' ? 'rush' : 'brute'
const OUT = process.env.BOTRUN_OUT ?? `data/runs/BOTRUN${mode === 'rush' ? '_RUSH' : ''}.json`

const BOT_ID = 'p_bot'
/** Au-delà, on considère la partie perdue : le bot ne progresse plus. */
const MAX_DEATHS = 6
/** Un étage qui dépasse ça est un étage où le bot tourne en rond. */
const MAX_TICKS_PER_FLOOR = TICK_RATE * 60 * 6

/**
 * Distance de chaque tuile jusqu'à la cible, par BFS. Le bot n'a pas accès au
 * champ de flux de l'engine (qui pointe vers les joueurs, pas l'inverse).
 */
function distancesTo(state: GameState, gx: number, gy: number): Int16Array {
  const dist = new Int16Array(MAP_W * MAP_H).fill(-1)
  const start = gy * MAP_W + gx
  if (!isWalkable(state.tiles[start]!)) return dist
  dist[start] = 0
  const queue = [start]
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]!
    const d = dist[idx]!
    const x = idx % MAP_W
    const y = (idx / MAP_W) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue
      const ni = ny * MAP_W + nx
      if (dist[ni] !== -1 || !isWalkable(state.tiles[ni]!)) continue
      dist[ni] = d + 1
      queue.push(ni)
    }
  }
  return dist
}

/** Direction à prendre pour descendre le gradient depuis la position du bot. */
function stepToward(state: GameState, bot: Actor, dist: Int16Array): [number, number] {
  const tx = Math.floor(bot.x)
  const ty = Math.floor(bot.y)
  const here = dist[ty * MAP_W + tx] ?? -1
  if (here <= 0) return [0, 0]

  let best = here
  let goal: [number, number] | null = null
  // Uniquement les quatre voisins orthogonaux, comme la BFS : une diagonale
  // vers une case de distance plus faible peut couper un angle que la physique
  // refuse, et le bot reste alors coincé contre le mur indéfiniment.
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = tx + dx
    const ny = ty + dy
    const nd = dist[ny * MAP_W + nx] ?? -1
    if (nd < 0 || nd >= best) continue
    best = nd
    goal = [nx, ny]
  }
  if (!goal) return [0, 0]

  const gx = goal[0] + 0.5 - bot.x
  const gy = goal[1] + 0.5 - bot.y
  const len = Math.hypot(gx, gy) || 1
  return [gx / len, gy / len]
}

const state = createGame(seed)
const bot = addPlayer(state, BOT_ID, mode === 'rush' ? 'Pressé' : 'Bourrin')
const telemetry = new RunTelemetry('BOTRUN', state)

let deaths = 0
let floorTicks = 0
let startFloor = state.floor
let stalled = false

const label = mode === 'rush' ? 'Descente pressée (clé et on file)' : 'Descente bourrin (on nettoie tout)'
console.log(`\n${label} — graine ${seed}, ${floorsToRun} étage(s) visé(s)\n`)

while (state.floor < startFloor + floorsToRun && deaths < MAX_DEATHS && !stalled) {
  const me = state.actors[BOT_ID]!

  let input: PlayerInput = { mx: 0, my: 0, aim: me.aim, attack: false, sprint: false }

  if (me.alive && !me.downed) {
    const stairs = { x: state.stairs.x + 0.5, y: state.stairs.y + 0.5 }
    let goal: { x: number; y: number }

    if (mode === 'rush') {
      // Le strict nécessaire pour descendre : la clé si elle est tombée, sinon
      // le gardien qui la porte, sinon l'escalier. Tout le reste est ignoré —
      // le bot frappe quand même en permanence, donc il tue ce qui le bloque,
      // mais il ne va jamais chercher personne.
      const key = state.items.find((it) => it.kind === 'key')
      const keeper = Object.values(state.actors).find(
        (a) => a.kind === 'monster' && a.alive && (a.elite === true || a.boss === true),
      )
      goal = state.stairsLocked ? (key ?? keeper ?? stairs) : stairs
    } else {
      // Cible : le monstre le plus proche. À défaut, l'escalier — le bot ne
      // cherche jamais à fuir, c'est tout l'intérêt du test.
      let target: { x: number; y: number } | null = null
      let bestD = Infinity
      for (const a of Object.values(state.actors)) {
        if (a.kind !== 'monster' || !a.alive) continue
        const d = Math.hypot(a.x - me.x, a.y - me.y)
        if (d < bestD) {
          bestD = d
          target = a
        }
      }
      goal = target ?? stairs
    }

    const dist = distancesTo(state, Math.floor(goal.x), Math.floor(goal.y))
    const [mx, my] = stepToward(state, me, dist)

    // Depuis que payer demande une intention, le bot doit la formuler : sans
    // ça il traverse l'étal et le coffre sans jamais rien acheter, et la
    // mesure de l'économie tomberait à zéro par construction. Il reste
    // opportuniste — il ne va pas chercher un objet, il prend celui sur lequel
    // il passe et que l'équipe peut payer.
    const takeable = state.items.some((it) => {
      const price = it.kind === 'chest' ? chestPrice(state.floor) : it.price ?? 0
      if (price <= 0 || price > state.bones) return false
      return Math.hypot(it.x - me.x, it.y - me.y) <= PICKUP_RANGE
    })

    input = {
      sprint: false,
      mx,
      my,
      aim: Math.atan2(goal.y - me.y, goal.x - me.x),
      attack: true,
      ...(takeable ? { take: true } : {}),
    }
  }

  const floorBefore = state.floor
  step(state, { [BOT_ID]: input })
  telemetry.observe(state, state.events)

  for (const ev of state.events) {
    if (ev.t === 'death' && ev.kind === 'player') deaths++
  }

  floorTicks++
  if (state.floor !== floorBefore) {
    floorTicks = 0
  } else if (floorTicks > MAX_TICKS_PER_FLOOR) {
    stalled = true
  }
}

if (process.env.BOTRUN_DEBUG && stalled) {
  console.log('DEBUG survivants :')
  for (const a of Object.values(state.actors)) {
    if (a.kind === 'monster' && a.alive)
      console.log(' ', a.species, a.name, 'à', a.x.toFixed(1), a.y.toFixed(1), 'hp', a.hp)
  }
  const me = state.actors[BOT_ID]!
  console.log('  bot à', me.x.toFixed(1), me.y.toFixed(1), 'hp', me.hp, 'arme', me.weapon)
  console.log('  stairsLocked', state.stairsLocked, 'stairs', JSON.stringify(state.stairs), 'reserve', state.reserveCount)
  console.log('  items clés :', state.items.filter((i) => i.kind === 'key').length)
}

startFloor = state.floor

console.log('── Ce que ça a donné ──────────────────────────────────────────')
for (const f of telemetry.floors) console.log('  ' + floorSummary(f))

const cleared = telemetry.floors.filter((f) => f.ticks > 0)
const painless = cleared.filter((f) => f.lowestHpRatio > 0.7 && f.dangerRatio < 0.02)
const firstReal = cleared.find((f) => f.lowestHpRatio <= 0.5)

console.log('\n── Verdict ────────────────────────────────────────────────────')
console.log(`  ${cleared.length} étage(s) parcouru(s), ${deaths} mort(s)`)
console.log(
  painless.length
    ? `  Étage(s) sans le moindre enjeu : ${painless.map((f) => f.floor).join(', ')}`
    : '  Aucun étage traversé sans encaisser : bien.',
)
console.log(
  firstReal
    ? `  Premier étage réellement dangereux (PV sous 50 %) : ${firstReal.floor}`
    : '  Le bot n\'est jamais descendu sous 50 % de PV — le jeu est trop permissif.',
)
if (stalled) console.log('  Bloqué : le bot n\'a pas trouvé la sortie dans le temps imparti.')

// On écrit le relevé au même format que le serveur, pour pouvoir enchaîner sur
// le rapport détaillé sans avoir à lancer une partie réelle.
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(telemetry.toRecord(seed, new Date().toISOString())), 'utf8')
console.log(`\n  Relevé écrit dans ${OUT}`)
console.log(`  Détail : npx tsx scripts/report.ts ${OUT}\n`)
