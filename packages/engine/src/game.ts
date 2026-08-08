/**
 * Cœur du jeu : création d'état et fonction de pas.
 *
 * `step()` reste déterministe et sans effet de bord externe. Le client réutilise
 * `movePhysical()` pour prédire son propre déplacement entre deux paquets
 * serveur — c'est le même code des deux côtés, donc la prédiction ne peut pas
 * diverger pour cause de règles différentes.
 */
import { buildFlowField, decideMonsterAction } from './ai.js'
import { computeFov } from './fov.js'
import { generateFloor } from './mapgen.js'
import { inAttackArc, moveWithCollision, separateActors } from './physics.js'
import { Rng } from './rng.js'
import type { Actor, GameState, PlayerInput } from './types.js'
import {
  ACTOR_RADIUS,
  AGGRO_MAX_DIST,
  ATTACK_COOLDOWN,
  ATTACK_HALF_ARC,
  ATTACK_KNOCKBACK,
  ATTACK_REACH,
  ATTACK_SWING,
  DT,
  FOV_RADIUS,
  KNOCKBACK_DECAY,
  MONSTERS,
  MONSTER_HALF_ARC,
  PLAYER_ATK,
  PLAYER_MAX_HP,
  PLAYER_SPEED,
  RESPAWN_GRACE,
  RESPAWN_TICKS,
  Tile,
} from './types.js'

/**
 * Applique un pas de déplacement physique. Partagé par le serveur et la
 * prédiction client, d'où la signature sur les tuiles brutes plutôt que sur un
 * GameState complet.
 */
export function movePhysical(
  tiles: Uint8Array,
  w: number,
  h: number,
  actor: { x: number; y: number; kx: number; ky: number },
  mx: number,
  my: number,
  speed: number,
): void {
  let dx = mx
  let dy = my
  const len = Math.hypot(dx, dy)
  // On normalise seulement au-delà de 1 : un stick analogique à mi-course doit
  // pouvoir donner une vitesse réduite.
  if (len > 1) {
    dx /= len
    dy /= len
  }

  const vx = dx * speed + actor.kx
  const vy = dy * speed + actor.ky
  const next = moveWithCollision(tiles, w, h, actor.x, actor.y, vx * DT, vy * DT, ACTOR_RADIUS)
  actor.x = next.x
  actor.y = next.y

  const decay = Math.exp(-KNOCKBACK_DECAY * DT)
  actor.kx *= decay
  actor.ky *= decay
  if (Math.abs(actor.kx) < 0.05) actor.kx = 0
  if (Math.abs(actor.ky) < 0.05) actor.ky = 0
}

function monsterPool(floor: number): string[] {
  const pool = ['skeleton', 'skeleton_rogue']
  if (floor >= 2) pool.push('orc', 'skeleton_warrior')
  if (floor >= 4) pool.push('orc_warrior', 'skeleton_mage')
  if (floor >= 6) pool.push('orc_rogue', 'orc_mage')
  return pool
}

function populate(
  state: GameState,
  rooms: { x: number; y: number; w: number; h: number }[],
  rng: Rng,
): void {
  const pool = monsterPool(state.floor)
  const count = 6 + state.floor * 2
  const spawnable = rooms.slice(1)
  if (spawnable.length === 0) return

  for (let i = 0; i < count; i++) {
    const room = rng.pick(spawnable)
    const x = room.x + rng.int(room.w) + 0.5
    const y = room.y + rng.int(room.h) + 0.5
    if (!isFree(state, x, y)) continue

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
      kx: 0,
      ky: 0,
      hp: def.maxHp,
      maxHp: def.maxHp,
      atk: def.atk,
      aim: 0,
      alive: true,
      swingUntil: 0,
      readyAt: state.tick + rng.int(30),
    }
  }
}

function isFree(state: GameState, x: number, y: number): boolean {
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false
  if (state.tiles[ty * state.width + tx] === Tile.Wall) return false
  for (const a of Object.values(state.actors)) {
    if (a.alive && Math.hypot(a.x - x, a.y - y) < ACTOR_RADIUS * 2) return false
  }
  return true
}

function findFreeSpot(state: GameState, cx: number, cy: number): { x: number; y: number } {
  for (let r = 0; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = Math.floor(cx) + dx + 0.5
        const y = Math.floor(cy) + dy + 0.5
        if (isFree(state, x, y)) return { x, y }
      }
    }
  }
  return { x: state.spawn.x + 0.5, y: state.spawn.y + 0.5 }
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

export function descend(state: GameState): void {
  const rng = new Rng(state.rng)
  state.floor += 1
  const layout = generateFloor(rng, state.floor)

  state.tiles = layout.tiles
  state.width = layout.width
  state.height = layout.height
  state.stairs = layout.stairs
  state.spawn = layout.spawn

  for (const a of Object.values(state.actors)) {
    if (a.kind === 'monster') delete state.actors[a.id]
  }

  for (const a of Object.values(state.actors)) {
    a.x = layout.spawn.x + 0.5
    a.y = layout.spawn.y + 0.5
    a.kx = 0
    a.ky = 0
    a.readyAt = state.tick
    a.swingUntil = 0
    delete a.windupUntil
    if (!a.alive) {
      a.alive = true
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
      delete a.respawnAt
    }
    a.invulnUntil = state.tick + RESPAWN_GRACE
  }

  populate(state, layout.rooms, rng)
  state.rng = rng.s
  state.events.push({ t: 'descend', floor: state.floor })
}

export function addPlayer(state: GameState, id: string, name: string): Actor {
  const existing = state.actors[id]
  if (existing) return existing

  const anchor = Object.values(state.actors).find((a) => a.kind === 'player' && a.alive)
  const base = anchor ?? { x: state.spawn.x + 0.5, y: state.spawn.y + 0.5 }
  const pos = findFreeSpot(state, base.x, base.y)

  const actor: Actor = {
    id,
    kind: 'player',
    species: 'hero',
    name,
    x: pos.x,
    y: pos.y,
    kx: 0,
    ky: 0,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    atk: PLAYER_ATK,
    aim: 0,
    alive: true,
    swingUntil: 0,
    readyAt: state.tick,
    invulnUntil: state.tick + RESPAWN_GRACE,
  }
  state.actors[id] = actor
  return actor
}

export function removePlayer(state: GameState, id: string): void {
  delete state.actors[id]
}

function damage(
  state: GameState,
  from: Actor,
  to: Actor,
  knockback: number,
  rng: Rng,
): void {
  if (to.invulnUntil !== undefined && state.tick < to.invulnUntil) return

  const dmg = Math.max(1, from.atk + rng.range(-1, 2))
  to.hp -= dmg

  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  to.kx += Math.cos(ang) * knockback
  to.ky += Math.sin(ang) * knockback

  state.events.push({ t: 'hit', from: from.id, to: to.id, dmg, x: to.x, y: to.y })

  if (to.hp <= 0) {
    to.hp = 0
    to.alive = false
    state.events.push({ t: 'death', id: to.id, kind: to.kind, x: to.x, y: to.y })
    if (to.kind === 'player') {
      to.respawnAt = state.tick + RESPAWN_TICKS
    } else {
      delete state.actors[to.id]
    }
  }
}

/** Coup d'épée du joueur : frappe tout ce qui est dans l'arc, pas une seule cible. */
function playerSwing(state: GameState, actor: Actor, rng: Rng): void {
  actor.readyAt = state.tick + ATTACK_COOLDOWN
  actor.swingUntil = state.tick + ATTACK_SWING
  state.events.push({ t: 'swing', id: actor.id, x: actor.x, y: actor.y, aim: actor.aim })

  for (const target of Object.values(state.actors)) {
    if (!target.alive || target.kind === actor.kind) continue
    if (
      !inAttackArc(
        actor.x, actor.y, actor.aim,
        ATTACK_HALF_ARC, ATTACK_REACH,
        target.x, target.y, ACTOR_RADIUS,
      )
    ) {
      continue
    }
    damage(state, actor, target, ATTACK_KNOCKBACK, rng)
  }
}

function monsterStrike(state: GameState, m: Actor, rng: Rng): void {
  const def = MONSTERS[m.species]!
  m.readyAt = state.tick + def.cooldown
  m.swingUntil = state.tick + ATTACK_SWING
  state.events.push({ t: 'swing', id: m.id, x: m.x, y: m.y, aim: m.aim })

  for (const target of Object.values(state.actors)) {
    if (!target.alive || target.kind !== 'player') continue
    if (
      !inAttackArc(
        m.x, m.y, m.aim,
        MONSTER_HALF_ARC, def.reach,
        target.x, target.y, ACTOR_RADIUS,
      )
    ) {
      continue
    }
    damage(state, m, target, def.knockback, rng)
  }
}

export interface StepResult {
  visible: Uint8Array
}

export function step(
  state: GameState,
  inputs: Record<string, PlayerInput | null>,
  scratch?: { visible: Uint8Array; flow: Int16Array },
): StepResult {
  state.tick += 1
  state.events = []

  const size = state.width * state.height
  const visible = scratch?.visible?.length === size ? scratch.visible : new Uint8Array(size)
  const flow = scratch?.flow?.length === size ? scratch.flow : new Int16Array(size)
  visible.fill(0)

  const rng = new Rng(state.rng)

  // 1. Réapparitions dues.
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || a.alive) continue
    if (a.respawnAt !== undefined && state.tick >= a.respawnAt) {
      const mate = Object.values(state.actors).find(
        (o) => o.kind === 'player' && o.alive && o.id !== a.id,
      )
      const base = mate ?? { x: state.spawn.x + 0.5, y: state.spawn.y + 0.5 }
      const pos = findFreeSpot(state, base.x, base.y)
      a.x = pos.x
      a.y = pos.y
      a.kx = 0
      a.ky = 0
      a.alive = true
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
      a.readyAt = state.tick
      // Sans ce répit, on réapparaît dans l'arc du monstre qui vient de nous
      // tuer et on remeurt aussitôt.
      a.invulnUntil = state.tick + RESPAWN_GRACE
      delete a.respawnAt
      state.events.push({ t: 'respawn', id: a.id, x: a.x, y: a.y })
    }
  }

  // 2. Champ de vision de l'équipe (rendu + aggro).
  for (const a of Object.values(state.actors)) {
    if (a.kind === 'player' && a.alive) {
      computeFov(
        state.tiles, state.width, state.height,
        Math.floor(a.x), Math.floor(a.y), FOV_RADIUS, visible,
      )
    }
  }

  buildFlowField(state, flow, AGGRO_MAX_DIST + 4)

  // 3. Joueurs.
  const floorAtStart = state.floor
  for (const actor of Object.values(state.actors)) {
    if (actor.kind !== 'player' || !actor.alive) continue
    const input = inputs[actor.id]
    if (!input) {
      movePhysical(state.tiles, state.width, state.height, actor, 0, 0, 0)
      continue
    }

    actor.aim = input.aim
    movePhysical(state.tiles, state.width, state.height, actor, input.mx, input.my, PLAYER_SPEED)

    if (input.attack && state.tick >= actor.readyAt) playerSwing(state, actor, rng)
  }

  // 4. Monstres.
  for (const m of Object.values(state.actors)) {
    if (m.kind !== 'monster' || !m.alive) continue

    const action = decideMonsterAction(state, m, flow, visible)
    const def = MONSTERS[m.species]!

    if (action.type === 'windup') {
      if (m.windupUntil === undefined) {
        m.windupUntil = state.tick + def.windup
        m.aim = action.aim
        state.events.push({ t: 'windup', id: m.id, x: m.x, y: m.y, aim: m.aim })
      } else if (state.tick >= m.windupUntil) {
        m.windupUntil = undefined
        // L'angle est resté figé pendant la préparation : si le joueur s'est
        // déplacé hors de l'arc, le coup part dans le vide. C'est l'esquive.
        monsterStrike(state, m, rng)
      }
      movePhysical(state.tiles, state.width, state.height, m, 0, 0, 0)
      continue
    }

    m.windupUntil = undefined
    if (action.type === 'move') {
      m.aim = action.aim
      movePhysical(state.tiles, state.width, state.height, m, action.mx, action.my, def.speed)
    } else {
      movePhysical(state.tiles, state.width, state.height, m, 0, 0, 0)
    }
  }

  // 5. Anti-empilement.
  separateActors(Object.values(state.actors), ACTOR_RADIUS)

  // 6. Escalier : il suffit de marcher dessus.
  if (state.floor === floorAtStart) {
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player' || !a.alive) continue
      if (Math.hypot(a.x - (state.stairs.x + 0.5), a.y - (state.stairs.y + 0.5)) < 0.6) {
        descend(state)
        break
      }
    }
  }

  state.rng = rng.s
  return { visible }
}
