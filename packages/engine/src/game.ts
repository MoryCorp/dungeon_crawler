/**
 * Le cœur du jeu : création d'état et fonction de pas (step).
 *
 * `step()` est déterministe et sans effet de bord externe — mêmes état + mêmes
 * intentions donnent toujours le même résultat. C'est ce qui permet au serveur
 * de faire autorité et au client d'exécuter exactement le même code pour la
 * prédiction locale.
 */
import { buildFlowField, decideMonsterIntent } from './ai.js'
import { computeFov } from './fov.js'
import { generateFloor } from './mapgen.js'
import { Rng } from './rng.js'
import type { Actor, Dir, GameEvent, GameState, Intent } from './types.js'
import {
  AGGRO_MAX_DIST,
  COST,
  DIR_VEC,
  FOV_RADIUS,
  MONSTERS,
  PLAYER_ATK,
  PLAYER_MAX_HP,
  RESPAWN_TICKS,
  Tile,
  isWalkable,
} from './types.js'

/** Quels monstres apparaissent selon la profondeur. */
function monsterPool(floor: number): string[] {
  const pool = ['skeleton', 'skeleton_rogue']
  if (floor >= 2) pool.push('orc', 'skeleton_warrior')
  if (floor >= 4) pool.push('orc_warrior', 'skeleton_mage')
  if (floor >= 6) pool.push('orc_rogue', 'orc_mage')
  return pool
}

function populate(state: GameState, rooms: { x: number; y: number; w: number; h: number }[], rng: Rng): void {
  const pool = monsterPool(state.floor)
  const count = 6 + state.floor * 2
  // On exclut la première salle : arriver au milieu d'un comité d'accueil
  // n'est pas une difficulté, c'est une frustration.
  const spawnable = rooms.slice(1)
  if (spawnable.length === 0) return

  for (let i = 0; i < count; i++) {
    const room = rng.pick(spawnable)
    const x = room.x + rng.int(room.w)
    const y = room.y + rng.int(room.h)
    if (!isWalkable(state.tiles[y * state.width + x]!)) continue
    if (actorAtPos(state, x, y)) continue

    const species = rng.pick(pool)
    const def = MONSTERS[species]!
    const id = `m${state.floor}_${i}`
    state.actors[id] = {
      id,
      kind: 'monster',
      species,
      name: def.label,
      x,
      y,
      hp: def.maxHp,
      maxHp: def.maxHp,
      atk: def.atk,
      facing: 'S',
      readyAt: state.tick + rng.int(10),
      alive: true,
    }
  }
}

function actorAtPos(state: GameState, x: number, y: number): Actor | null {
  for (const a of Object.values(state.actors)) {
    if (a.alive && a.x === x && a.y === y) return a
  }
  return null
}

export function createGame(seed: number, floor = 1): GameState {
  const rng = new Rng(seed)
  const layout = generateFloor(rng, floor)

  const state: GameState = {
    tick: 0,
    floor,
    seed,
    rng: rng.s,
    width: layout.width,
    height: layout.height,
    tiles: layout.tiles,
    actors: {},
    stairs: layout.stairs,
    spawn: layout.spawn,
    events: [],
  }

  populate(state, layout.rooms, rng)
  state.rng = rng.s
  return state
}

/** Descend d'un étage : nouvelle carte, monstres neufs, joueurs regroupés au spawn. */
export function descend(state: GameState): void {
  const rng = new Rng(state.rng)
  state.floor += 1
  const layout = generateFloor(rng, state.floor)

  state.tiles = layout.tiles
  state.width = layout.width
  state.height = layout.height
  state.stairs = layout.stairs
  state.spawn = layout.spawn

  // Les monstres ne suivent pas entre les étages.
  for (const a of Object.values(state.actors)) {
    if (a.kind === 'monster') delete state.actors[a.id]
  }

  for (const a of Object.values(state.actors)) {
    a.x = layout.spawn.x
    a.y = layout.spawn.y
    a.readyAt = state.tick
    // Un étage franchi remet tout le monde debout : on veut que l'équipe
    // reparte ensemble, pas qu'un joueur subisse son respawn deux étages.
    if (!a.alive) {
      a.alive = true
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
      delete a.respawnAt
    }
  }

  populate(state, layout.rooms, rng)
  state.rng = rng.s
  state.events.push({ t: 'descend', floor: state.floor })
}

export function addPlayer(state: GameState, id: string, name: string): Actor {
  const existing = state.actors[id]
  if (existing) return existing

  // On tente de placer le nouveau venu près de l'équipe plutôt qu'au spawn.
  const anchor =
    Object.values(state.actors).find((a) => a.kind === 'player' && a.alive) ?? null
  const base = anchor ? { x: anchor.x, y: anchor.y } : state.spawn
  const pos = findFreeTileNear(state, base.x, base.y) ?? state.spawn

  const actor: Actor = {
    id,
    kind: 'player',
    species: 'hero',
    name,
    x: pos.x,
    y: pos.y,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    atk: PLAYER_ATK,
    facing: 'S',
    readyAt: state.tick,
    alive: true,
  }
  state.actors[id] = actor
  return actor
}

export function removePlayer(state: GameState, id: string): void {
  delete state.actors[id]
}

function findFreeTileNear(
  state: GameState,
  cx: number,
  cy: number,
  maxRadius = 8,
): { x: number; y: number } | null {
  for (let r = 0; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue
        if (!isWalkable(state.tiles[y * state.width + x]!)) continue
        if (actorAtPos(state, x, y)) continue
        return { x, y }
      }
    }
  }
  return null
}

function buildOccupancy(state: GameState): (Actor | null)[] {
  const occ: (Actor | null)[] = new Array(state.width * state.height).fill(null)
  for (const a of Object.values(state.actors)) {
    if (a.alive) occ[a.y * state.width + a.x] = a
  }
  return occ
}

function attack(state: GameState, attacker: Actor, target: Actor, rng: Rng): void {
  const dmg = Math.max(1, attacker.atk + rng.range(-1, 2))
  target.hp -= dmg
  state.events.push({
    t: 'hit',
    from: attacker.id,
    to: target.id,
    dmg,
    x: target.x,
    y: target.y,
  })

  if (target.hp <= 0) {
    target.hp = 0
    target.alive = false
    state.events.push({ t: 'death', id: target.id, kind: target.kind, x: target.x, y: target.y })
    if (target.kind === 'player') {
      target.respawnAt = state.tick + RESPAWN_TICKS
    } else {
      delete state.actors[target.id]
    }
  }
}

function applyIntent(
  state: GameState,
  actor: Actor,
  intent: Intent,
  occ: (Actor | null)[],
  rng: Rng,
): void {
  const w = state.width
  const isPlayer = actor.kind === 'player'
  const def = isPlayer ? null : MONSTERS[actor.species]

  if (intent.type === 'wait') {
    actor.readyAt = state.tick + 1
    return
  }

  const [dx, dy] = DIR_VEC[intent.dir]
  const nx = actor.x + dx
  const ny = actor.y + dy
  actor.facing = intent.dir

  if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) {
    actor.readyAt = state.tick + 1
    return
  }

  const ni = ny * w + nx
  const target = occ[ni]

  // Se déplacer vers un ennemi = l'attaquer. Pas de touche dédiée à apprendre,
  // et ça évite les attaques dans le vide.
  const hostile = target && target.alive && target.kind !== actor.kind
  if (intent.type === 'attack' || hostile) {
    if (target && target.alive && target.kind !== actor.kind) {
      attack(state, actor, target, rng)
      actor.readyAt = state.tick + (def ? def.attackCost : COST.playerAttack)
    } else {
      // Coup dans le vide : on paye quand même, sinon spammer l'attaque est gratuit.
      actor.readyAt = state.tick + (def ? def.attackCost : COST.playerAttack)
    }
    return
  }

  if (!isWalkable(state.tiles[ni]!) || target) {
    actor.readyAt = state.tick + 1
    return
  }

  occ[actor.y * w + actor.x] = null
  actor.x = nx
  actor.y = ny
  occ[ni] = actor
  actor.readyAt = state.tick + (def ? def.moveCost : COST.playerMove)

  if (isPlayer && state.tiles[ni] === Tile.Stairs) {
    descend(state)
  }
}

export interface StepResult {
  /** Union des champs de vision de l'équipe pour ce tick (1 = visible). */
  visible: Uint8Array
}

/**
 * Avance la simulation d'un tick.
 * `intents` contient l'intention courante de chaque joueur (celle qu'il
 * maintient), appliquée dès que son cooldown le permet.
 */
export function step(
  state: GameState,
  intents: Record<string, Intent | null>,
  scratch?: { visible: Uint8Array; flow: Int16Array },
): StepResult {
  state.tick += 1
  state.events = []

  const size = state.width * state.height
  const visible = scratch?.visible?.length === size ? scratch.visible : new Uint8Array(size)
  const flow = scratch?.flow?.length === size ? scratch.flow : new Int16Array(size)
  visible.fill(0)

  const rng = new Rng(state.rng)

  // 1. Respawns dus.
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || a.alive) continue
    if (a.respawnAt !== undefined && state.tick >= a.respawnAt) {
      const mate = Object.values(state.actors).find(
        (o) => o.kind === 'player' && o.alive && o.id !== a.id,
      )
      const base = mate ? { x: mate.x, y: mate.y } : state.spawn
      const pos = findFreeTileNear(state, base.x, base.y) ?? state.spawn
      a.x = pos.x
      a.y = pos.y
      a.alive = true
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
      a.readyAt = state.tick
      delete a.respawnAt
      state.events.push({ t: 'respawn', id: a.id, x: a.x, y: a.y })
    }
  }

  // 2. Champ de vision de l'équipe (sert au rendu ET à l'aggro des monstres).
  for (const a of Object.values(state.actors)) {
    if (a.kind === 'player' && a.alive) {
      computeFov(state.tiles, state.width, state.height, a.x, a.y, FOV_RADIUS, visible)
    }
  }

  // 3. Champ de distance vers les joueurs, calculé une fois pour tous les monstres.
  buildFlowField(state, flow, AGGRO_MAX_DIST + 4)

  // 4. Chaque acteur dont le cooldown est écoulé agit.
  const occ = buildOccupancy(state)
  // Ordre stable (par id) : deux joueurs qui visent la même case au même tick
  // sont départagés de façon déterministe, pas par l'ordre d'insertion.
  const actors = Object.values(state.actors).sort((a, b) => (a.id < b.id ? -1 : 1))

  const floorAtStart = state.floor

  for (const actor of actors) {
    if (!actor.alive || state.actors[actor.id] === undefined) continue
    if (actor.readyAt > state.tick) continue

    if (actor.kind === 'player') {
      const intent = intents[actor.id]
      if (intent) applyIntent(state, actor, intent, occ, rng)
    } else {
      const intent = decideMonsterIntent(state, actor, flow, visible, occ, rng)
      applyIntent(state, actor, intent, occ, rng)
    }

    // Un joueur vient de prendre l'escalier : la carte, les monstres et les
    // positions viennent d'être remplacés, donc `occ` et `flow` sont périmés.
    // On rend la main, le tick suivant repartira sur le nouvel étage.
    if (state.floor !== floorAtStart) break
  }

  state.rng = rng.s
  return { visible }
}
