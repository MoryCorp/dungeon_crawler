/**
 * Cœur du jeu : création d'état et fonction de pas.
 *
 * `step()` reste déterministe et sans effet de bord externe. Le client réutilise
 * `movePhysical()` pour prédire son propre déplacement — même code des deux
 * côtés, donc la prédiction ne peut pas diverger pour cause de règles
 * différentes.
 */
import { buildFlowField, decideMonsterAction } from './ai.js'
import { computeFov } from './fov.js'
import { generateFloor, type Rect } from './mapgen.js'
import { inAttackArc, moveWithCollision, separateActors, solidAt, unstick } from './physics.js'
import { Rng } from './rng.js'
import type { Actor, GameState, GroundItem, PlayerInput, Projectile } from './types.js'
import {
  ACTOR_RADIUS,
  AGGRO_MAX_DIST,
  ATK_PER_LEVEL,
  ATTACK_SWING,
  BLEED_OUT_TICKS,
  BOSS_ATK_MULT,
  BOSS_EVERY,
  BOSS_HP_MULT,
  BOSS_SPECIES,
  BOSS_XP_MULT,
  DOWNED_SPEED,
  DT,
  ELITE_ATK_MULT,
  ELITE_HP_MULT,
  ELITE_XP_MULT,
  FOV_RADIUS,
  HEART_HEAL,
  HP_PER_LEVEL,
  KNOCKBACK_DECAY,
  LOOT_WEAPONS,
  MONSTERS,
  MONSTER_HALF_ARC,
  PICKUP_RANGE,
  PLAYER_BASE_ATK,
  PLAYER_BASE_HP,
  PLAYER_SPEED,
  PROJECTILE_RADIUS,
  RESPAWN_GRACE,
  RESPAWN_TICKS,
  REVIVE_HP_RATIO,
  REVIVE_RANGE,
  REVIVE_TICKS,
  STARTING_WEAPON,
  Tile,
  WEAPONS,
  XP_MAGNET_RANGE,
  XP_MAGNET_SPEED,
  xpForLevel,
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

/** Vitesse effective d'un joueur : ramper quand on est à terre. */
export function playerSpeed(actor: Actor): number {
  return actor.downed ? DOWNED_SPEED : PLAYER_SPEED
}

// ---------------------------------------------------------------- peuplement

function monsterPool(floor: number): string[] {
  const pool = ['skeleton', 'bat']
  if (floor >= 2) pool.push('orc', 'orc_rogue')
  if (floor >= 3) pool.push('skeleton_mage', 'skeleton_rogue')
  if (floor >= 4) pool.push('skeleton_warrior', 'orc_bomber')
  if (floor >= 6) pool.push('orc_warrior', 'orc_mage')
  return pool
}

function spawnMonster(
  state: GameState,
  id: string,
  species: string,
  x: number,
  y: number,
  rank: 'normal' | 'elite' | 'boss',
  rng: Rng,
): Actor {
  const def = MONSTERS[species]!
  const hpMult = rank === 'boss' ? BOSS_HP_MULT : rank === 'elite' ? ELITE_HP_MULT : 1
  const atkMult = rank === 'boss' ? BOSS_ATK_MULT : rank === 'elite' ? ELITE_ATK_MULT : 1
  const hp = Math.round(def.maxHp * hpMult)

  const actor: Actor = {
    id,
    kind: 'monster',
    species,
    name: rank === 'boss' ? `${def.label} colossal` : rank === 'elite' ? `${def.label} d'élite` : def.label,
    x,
    y,
    kx: 0,
    ky: 0,
    hp,
    maxHp: hp,
    atk: Math.round(def.atk * atkMult),
    aim: rng.next() * Math.PI * 2,
    alive: true,
    swingUntil: 0,
    readyAt: state.tick + rng.int(30),
  }
  if (rank === 'elite') actor.elite = true
  if (rank === 'boss') actor.boss = true
  state.actors[id] = actor
  return actor
}

function populate(state: GameState, rooms: Rect[], rng: Rng): void {
  const pool = monsterPool(state.floor)
  const count = 8 + state.floor * 2
  // On exclut la salle de spawn : arriver au milieu d'un comité d'accueil
  // n'est pas une difficulté, c'est une frustration.
  const spawnable = rooms.slice(1)
  if (spawnable.length === 0) return

  for (let i = 0; i < count; i++) {
    const room = rng.pick(spawnable)
    const x = room.x + rng.int(room.w) + 0.5
    const y = room.y + rng.int(room.h) + 0.5
    if (!isFree(state, x, y)) continue
    spawnMonster(state, `m${state.floor}_${i}`, rng.pick(pool), x, y, 'normal', rng)
  }

  // Le porteur de clé : une cible désignée, dans la salle la plus lointaine.
  // Jamais une espèce d'essaim — un rat géant en gardien de donjon ne fait pas
  // un combat, juste un sac de points de vie qui vole.
  const isBossFloor = state.floor % BOSS_EVERY === 0
  const keeperPool = pool.filter((s) => MONSTERS[s]!.behavior !== 'swarm')
  const keeperRoom = spawnable[spawnable.length - 1]!
  const kx = keeperRoom.x + Math.floor(keeperRoom.w / 2) + 0.5
  const ky = keeperRoom.y + Math.floor(keeperRoom.h / 2) + 0.5
  spawnMonster(
    state,
    `keeper${state.floor}`,
    isBossFloor ? BOSS_SPECIES : rng.pick(keeperPool.length ? keeperPool : pool),
    kx,
    ky,
    isBossFloor ? 'boss' : 'elite',
    rng,
  )

  // Coffres : une raison d'explorer les salles au lieu de courir à l'escalier.
  const chestRooms = rng.shuffle([...spawnable]).slice(0, state.floor >= 3 ? 2 : 1)
  for (const room of chestRooms) {
    const x = room.x + rng.int(room.w) + 0.5
    const y = room.y + rng.int(room.h) + 0.5
    if (!isWalkableAt(state, x, y)) continue
    state.items.push({ id: `i${state.nextId++}`, kind: 'chest', x, y })
  }
}

function isWalkableAt(state: GameState, x: number, y: number): boolean {
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return false
  return state.tiles[ty * state.width + tx] !== Tile.Wall
}

function isFree(state: GameState, x: number, y: number): boolean {
  if (!isWalkableAt(state, x, y)) return false
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

// ---------------------------------------------------------------- cycle de vie

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
    projectiles: [],
    items: [],
    nextId: 1,
    stairs: layout.stairs,
    spawn: layout.spawn,
    stairsLocked: true,
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
  state.stairsLocked = true
  state.projectiles = []
  state.items = []

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
    // Franchir un étage remet tout le monde debout : on veut que l'équipe
    // reparte ensemble, pas qu'un joueur subisse sa mort deux étages durant.
    if (!a.alive || a.downed) {
      a.alive = true
      a.downed = false
      a.reviveProgress = 0
      delete a.bleedOutAt
      delete a.respawnAt
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
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

  const anchor = Object.values(state.actors).find(
    (a) => a.kind === 'player' && a.alive && !a.downed,
  )
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
    hp: PLAYER_BASE_HP,
    maxHp: PLAYER_BASE_HP,
    atk: PLAYER_BASE_ATK,
    aim: 0,
    alive: true,
    swingUntil: 0,
    readyAt: state.tick,
    invulnUntil: state.tick + RESPAWN_GRACE,
    weapon: STARTING_WEAPON,
    level: 1,
    xp: 0,
    downed: false,
    reviveProgress: 0,
  }
  state.actors[id] = actor
  return actor
}

export function removePlayer(state: GameState, id: string): void {
  delete state.actors[id]
}

// ---------------------------------------------------------------- combat

/**
 * L'XP est commune à l'équipe : ramasser une orbe fait progresser tout le
 * monde. Sans ça, celui qui porte les coups distance les autres et le donjon
 * devient injouable pour la moitié du groupe.
 */
function grantXp(state: GameState, amount: number): void {
  for (const player of Object.values(state.actors)) {
    if (player.kind !== 'player') continue
    player.xp = (player.xp ?? 0) + amount
    let level = player.level ?? 1
    while (player.xp >= xpForLevel(level + 1)) {
      level++
      player.maxHp += HP_PER_LEVEL
      player.hp += HP_PER_LEVEL
      player.atk += ATK_PER_LEVEL
      state.events.push({ t: 'levelup', id: player.id, level, x: player.x, y: player.y })
    }
    player.level = level
  }
}

function dropLoot(state: GameState, victim: Actor, rng: Rng): void {
  const def = MONSTERS[victim.species]
  const mult = victim.boss ? BOSS_XP_MULT : victim.elite ? ELITE_XP_MULT : 1
  const xp = Math.round((def?.xp ?? 3) * mult)
  state.items.push({ id: `i${state.nextId++}`, kind: 'xp', x: victim.x, y: victim.y, amount: xp })

  if (victim.elite || victim.boss) {
    state.items.push({ id: `i${state.nextId++}`, kind: 'key', x: victim.x, y: victim.y })
    state.events.push({ t: 'keydrop', x: victim.x, y: victim.y })
    // Un porteur de clé lâche aussi de quoi encaisser la suite.
    state.items.push({ id: `i${state.nextId++}`, kind: 'heart', x: victim.x + 0.5, y: victim.y })
    state.items.push({ id: `i${state.nextId++}`, kind: 'heart', x: victim.x - 0.5, y: victim.y })
    if (victim.boss) {
      state.items.push({
        id: `i${state.nextId++}`, kind: 'weapon',
        x: victim.x, y: victim.y + 0.6, weapon: rng.pick(LOOT_WEAPONS),
      })
    }
  } else if (rng.chance(0.16)) {
    state.items.push({ id: `i${state.nextId++}`, kind: 'heart', x: victim.x, y: victim.y })
  }
}

function killOrDown(state: GameState, victim: Actor, rng: Rng): void {
  if (victim.kind === 'player') {
    // Mise à terre plutôt que mort sèche : un coéquipier peut encore le sauver.
    victim.hp = 0
    victim.downed = true
    victim.reviveProgress = 0
    victim.bleedOutAt = state.tick + BLEED_OUT_TICKS
    victim.kx = 0
    victim.ky = 0
    delete victim.windupUntil
    state.events.push({ t: 'downed', id: victim.id, x: victim.x, y: victim.y })
    return
  }

  victim.hp = 0
  victim.alive = false
  state.events.push({ t: 'death', id: victim.id, kind: victim.kind, x: victim.x, y: victim.y })
  dropLoot(state, victim, rng)
  delete state.actors[victim.id]
}

function damage(
  state: GameState,
  from: Actor | null,
  to: Actor,
  amount: number,
  knockback: number,
  originX: number,
  originY: number,
): void {
  if (!to.alive) return
  // Un joueur déjà à terre n'est plus une cible : le finir en boucle n'apporte
  // rien qu'une frustration.
  if (to.kind === 'player' && to.downed) return
  if (to.invulnUntil !== undefined && state.tick < to.invulnUntil) return

  to.hp -= amount
  const ang = Math.atan2(to.y - originY, to.x - originX)
  to.kx += Math.cos(ang) * knockback
  to.ky += Math.sin(ang) * knockback

  state.events.push({
    t: 'hit',
    from: from?.id ?? '',
    to: to.id,
    dmg: amount,
    x: to.x,
    y: to.y,
  })
}

function spawnProjectile(
  state: GameState,
  owner: Actor,
  aim: number,
  speed: number,
  dmg: number,
  knockback: number,
  ttl: number,
  color: number,
): void {
  state.projectiles.push({
    id: `pr${state.nextId++}`,
    ownerId: owner.id,
    hostileToPlayers: owner.kind === 'monster',
    // On décale du rayon de l'acteur, sinon le tir naît dans son propre corps.
    x: owner.x + Math.cos(aim) * (ACTOR_RADIUS + PROJECTILE_RADIUS + 0.02),
    y: owner.y + Math.sin(aim) * (ACTOR_RADIUS + PROJECTILE_RADIUS + 0.02),
    vx: Math.cos(aim) * speed,
    vy: Math.sin(aim) * speed,
    damage: dmg,
    knockback,
    ttl,
    color,
  })
}

/** Coup du joueur : arc devant lui, ou tir si l'arme est à distance. */
function playerAttack(state: GameState, actor: Actor, rng: Rng): void {
  const weapon = WEAPONS[actor.weapon ?? STARTING_WEAPON] ?? WEAPONS[STARTING_WEAPON]!
  actor.readyAt = state.tick + weapon.cooldown
  actor.swingUntil = state.tick + ATTACK_SWING
  state.events.push({
    t: 'swing',
    id: actor.id,
    x: actor.x,
    y: actor.y,
    aim: actor.aim,
    reach: weapon.reach,
    halfArc: weapon.halfArc,
  })

  const dmg = weapon.damage + actor.atk

  if (weapon.ranged) {
    spawnProjectile(
      state, actor, actor.aim,
      weapon.ranged.speed, dmg, weapon.knockback, weapon.ranged.ttl, weapon.color,
    )
    return
  }

  for (const target of Object.values(state.actors)) {
    if (!target.alive || target.kind === actor.kind) continue
    if (
      !inAttackArc(
        actor.x, actor.y, actor.aim,
        weapon.halfArc, weapon.reach,
        target.x, target.y, ACTOR_RADIUS,
      )
    ) {
      continue
    }
    damage(state, actor, target, dmg, weapon.knockback, actor.x, actor.y)
    // L'XP n'est pas donnée ici : elle tombe au sol en orbe, à ramasser.
    if (target.hp <= 0) killOrDown(state, target, rng)
  }
}

/** Explosion du kamikaze : touche tout le monde, y compris ses congénères. */
function explode(state: GameState, m: Actor, rng: Rng): void {
  const def = MONSTERS[m.species]!
  const radius = def.blastRadius ?? 2.5
  state.events.push({ t: 'blast', x: m.x, y: m.y, radius })

  for (const target of Object.values(state.actors)) {
    if (!target.alive || target.id === m.id) continue
    const dist = Math.hypot(target.x - m.x, target.y - m.y)
    if (dist > radius) continue
    // Dégâts dégressifs : sortir du centre limite la casse.
    const falloff = 1 - (dist / radius) * 0.55
    damage(state, m, target, Math.max(1, Math.round(m.atk * falloff)), def.knockback, m.x, m.y)
    if (target.hp <= 0) killOrDown(state, target, rng)
  }

  m.hp = 0
  m.alive = false
  state.events.push({ t: 'death', id: m.id, kind: m.kind, x: m.x, y: m.y })
  dropLoot(state, m, rng)
  delete state.actors[m.id]
}

function monsterStrike(state: GameState, m: Actor, rng: Rng): void {
  const def = MONSTERS[m.species]!
  m.readyAt = state.tick + def.cooldown
  m.swingUntil = state.tick + ATTACK_SWING

  switch (def.behavior) {
    case 'archer': {
      state.events.push({
        t: 'swing', id: m.id, x: m.x, y: m.y, aim: m.aim, reach: 0.9, halfArc: MONSTER_HALF_ARC,
      })
      spawnProjectile(
        state, m, m.aim,
        def.projectileSpeed ?? 8, m.atk, def.knockback, Math.round(def.reach / (def.projectileSpeed ?? 8) * 30) + 15,
        def.color,
      )
      return
    }

    case 'charger': {
      // Le coup ne part pas : c'est la ruée elle-même qui blesse.
      m.dashUntil = state.tick + (def.dashTicks ?? 12)
      m.dashVx = Math.cos(m.aim)
      m.dashVy = Math.sin(m.aim)
      return
    }

    case 'bomber': {
      explode(state, m, rng)
      return
    }

    default: {
      state.events.push({
        t: 'swing', id: m.id, x: m.x, y: m.y, aim: m.aim, reach: def.reach, halfArc: MONSTER_HALF_ARC,
      })
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
        damage(state, m, target, m.atk, def.knockback, m.x, m.y)
        if (target.hp <= 0) killOrDown(state, target, rng)
      }
    }
  }
}

// ---------------------------------------------------------------- sous-systèmes

function stepProjectiles(state: GameState, rng: Rng): void {
  for (let i = state.projectiles.length - 1; i >= 0; i--) {
    const p = state.projectiles[i]!
    p.ttl -= 1
    if (p.ttl <= 0) {
      state.projectiles.splice(i, 1)
      continue
    }

    p.x += p.vx * DT
    p.y += p.vy * DT

    if (solidAt(state.tiles, state.width, state.height, Math.floor(p.x), Math.floor(p.y))) {
      state.projectiles.splice(i, 1)
      continue
    }

    let consumed = false
    for (const target of Object.values(state.actors)) {
      if (!target.alive || target.id === p.ownerId) continue
      if (p.hostileToPlayers !== (target.kind === 'player')) continue
      if (target.kind === 'player' && target.downed) continue
      if (Math.hypot(target.x - p.x, target.y - p.y) > ACTOR_RADIUS + PROJECTILE_RADIUS) continue

      const owner = state.actors[p.ownerId] ?? null
      damage(state, owner, target, p.damage, p.knockback, p.x, p.y)
      if (target.hp <= 0) killOrDown(state, target, rng)
      consumed = true
      break
    }
    if (consumed) state.projectiles.splice(i, 1)
  }
}

function stepItems(state: GameState, rng: Rng): void {
  const players = Object.values(state.actors).filter((a) => a.kind === 'player' && a.alive && !a.downed)
  if (players.length === 0) return

  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i]!

    let nearest: Actor | null = null
    let bestD = Infinity
    for (const p of players) {
      const d = Math.hypot(p.x - item.x, p.y - item.y)
      if (d < bestD) {
        bestD = d
        nearest = p
      }
    }
    if (!nearest) continue

    // Objet qu'on vient soi-même de poser : il ne redevient ramassable que
    // lorsqu'on s'en éloigne. Un coéquipier, lui, peut le prendre tout de suite.
    if (item.lockedFor !== undefined) {
      const owner = state.actors[item.lockedFor]
      if (!owner || Math.hypot(owner.x - item.x, owner.y - item.y) > PICKUP_RANGE + 0.5) {
        delete item.lockedFor
      } else if (owner.id === nearest.id) {
        continue
      }
    }

    // Les orbes d'XP viennent à toi : ramasser à la case près n'est pas du jeu.
    if (item.kind === 'xp' && bestD < XP_MAGNET_RANGE) {
      const ang = Math.atan2(nearest.y - item.y, nearest.x - item.x)
      item.x += Math.cos(ang) * XP_MAGNET_SPEED * DT
      item.y += Math.sin(ang) * XP_MAGNET_SPEED * DT
    }

    const range = item.kind === 'chest' ? PICKUP_RANGE + 0.2 : PICKUP_RANGE
    if (Math.hypot(nearest.x - item.x, nearest.y - item.y) > range) continue

    switch (item.kind) {
      case 'xp':
        grantXp(state, item.amount ?? 1)
        break

      case 'heart':
        if (nearest.hp >= nearest.maxHp) continue // on laisse le soin par terre
        nearest.hp = Math.min(nearest.maxHp, nearest.hp + HEART_HEAL)
        break

      case 'key':
        state.stairsLocked = false
        state.events.push({ t: 'unlock' })
        break

      case 'weapon': {
        const previous = nearest.weapon ?? STARTING_WEAPON
        nearest.weapon = item.weapon ?? STARTING_WEAPON
        // L'ancienne arme reste au sol : un coéquipier peut la récupérer, et
        // on peut soi-même revenir la chercher après s'être éloigné.
        state.items.push({
          id: `i${state.nextId++}`, kind: 'weapon',
          x: item.x, y: item.y, weapon: previous, lockedFor: nearest.id,
        })
        break
      }

      case 'chest': {
        // Le contenu est verrouillé pour celui qui ouvre : il voit ce qui est
        // tombé avant de décider de changer d'arme, au lieu de subir l'échange.
        state.items.push({
          id: `i${state.nextId++}`, kind: 'weapon',
          x: item.x, y: item.y, weapon: rng.pick(LOOT_WEAPONS), lockedFor: nearest.id,
        })
        state.items.push({ id: `i${state.nextId++}`, kind: 'heart', x: item.x + 0.7, y: item.y })
        break
      }
    }

    state.events.push({
      t: 'pickup',
      id: nearest.id,
      kind: item.kind,
      x: item.x,
      y: item.y,
      label: item.kind === 'weapon' ? WEAPONS[item.weapon ?? '']?.label : undefined,
    })
    state.items.splice(i, 1)
  }
}

/** Mise à terre : saignement, et relève par un coéquipier resté à côté. */
function stepDowned(state: GameState): void {
  const standing = Object.values(state.actors).filter(
    (a) => a.kind === 'player' && a.alive && !a.downed,
  )

  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive || !a.downed) continue

    const helper = standing.find((s) => Math.hypot(s.x - a.x, s.y - a.y) <= REVIVE_RANGE)
    if (helper) {
      a.reviveProgress = (a.reviveProgress ?? 0) + 1 / REVIVE_TICKS
      if (a.reviveProgress >= 1) {
        a.downed = false
        a.reviveProgress = 0
        delete a.bleedOutAt
        a.hp = Math.max(1, Math.round(a.maxHp * REVIVE_HP_RATIO))
        a.invulnUntil = state.tick + RESPAWN_GRACE
        state.events.push({ t: 'revived', id: a.id, x: a.x, y: a.y })
        continue
      }
    } else if (a.reviveProgress) {
      // La progression redescend doucement : on peut lâcher une seconde pour
      // repousser un monstre sans tout recommencer.
      a.reviveProgress = Math.max(0, a.reviveProgress - 0.4 / REVIVE_TICKS)
    }

    if (a.bleedOutAt !== undefined && state.tick >= a.bleedOutAt) {
      a.alive = false
      a.downed = false
      a.reviveProgress = 0
      delete a.bleedOutAt
      a.respawnAt = state.tick + RESPAWN_TICKS
      state.events.push({ t: 'death', id: a.id, kind: 'player', x: a.x, y: a.y })
    }
  }
}

// ---------------------------------------------------------------- pas de simulation

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

  // 1. Réapparitions dues (après saignement complet).
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || a.alive) continue
    if (a.respawnAt !== undefined && state.tick >= a.respawnAt) {
      const mate = Object.values(state.actors).find(
        (o) => o.kind === 'player' && o.alive && !o.downed && o.id !== a.id,
      )
      const base = mate ?? { x: state.spawn.x + 0.5, y: state.spawn.y + 0.5 }
      const pos = findFreeSpot(state, base.x, base.y)
      a.x = pos.x
      a.y = pos.y
      a.kx = 0
      a.ky = 0
      a.alive = true
      a.downed = false
      a.hp = Math.max(1, Math.floor(a.maxHp / 2))
      a.readyAt = state.tick
      a.invulnUntil = state.tick + RESPAWN_GRACE
      delete a.respawnAt
      state.events.push({ t: 'respawn', id: a.id, x: a.x, y: a.y })
    }
  }

  stepDowned(state)

  // 2. Champ de vision de l'équipe (rendu + aggro). Un joueur à terre voit
  // encore : c'est ce qui lui permet d'appeler à l'aide.
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
  for (const actor of Object.values(state.actors)) {
    if (actor.kind !== 'player' || !actor.alive) continue
    const input = inputs[actor.id]
    if (!input) {
      movePhysical(state.tiles, state.width, state.height, actor, 0, 0, 0)
      continue
    }

    actor.aim = input.aim
    movePhysical(
      state.tiles, state.width, state.height, actor,
      input.mx, input.my, playerSpeed(actor),
    )

    if (input.attack && !actor.downed && state.tick >= actor.readyAt) {
      playerAttack(state, actor, rng)
    }
  }

  // 4. Monstres.
  for (const m of Object.values(state.actors)) {
    if (m.kind !== 'monster' || !m.alive) continue
    const def = MONSTERS[m.species]!

    // Ruée en cours : trajectoire droite, dégâts au contact, stoppée par un mur.
    if (m.dashUntil !== undefined && state.tick < m.dashUntil) {
      const beforeX = m.x
      const beforeY = m.y
      movePhysical(
        state.tiles, state.width, state.height, m,
        m.dashVx ?? 0, m.dashVy ?? 0, def.dashSpeed ?? 10,
      )
      const travelled = Math.hypot(m.x - beforeX, m.y - beforeY)

      let connected = false
      for (const target of Object.values(state.actors)) {
        if (!target.alive || target.kind !== 'player' || target.downed) continue
        if (Math.hypot(target.x - m.x, target.y - m.y) > ACTOR_RADIUS * 2 + 0.15) continue
        damage(state, m, target, m.atk, def.knockback, m.x, m.y)
        if (target.hp <= 0) killOrDown(state, target, rng)
        connected = true
      }

      // Mur pris de plein fouet, ou cible touchée : la ruée s'arrête, et le
      // monstre reste vulnérable un instant. C'est la récompense de l'esquive.
      if (connected || travelled < (def.dashSpeed ?? 10) * DT * 0.4) {
        delete m.dashUntil
        m.readyAt = state.tick + def.cooldown
      }
      continue
    }
    if (m.dashUntil !== undefined) delete m.dashUntil

    const action = decideMonsterAction(state, m, flow, visible)

    if (action.type === 'windup') {
      if (m.windupUntil === undefined) {
        m.windupUntil = state.tick + def.windup
        m.aim = action.aim
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

  stepProjectiles(state, rng)
  stepItems(state, rng)

  separateActors(state.tiles, state.width, state.height, Object.values(state.actors), ACTOR_RADIUS)
  for (const a of Object.values(state.actors)) {
    if (a.alive) unstick(state.tiles, state.width, state.height, a)
  }

  // 5. Escalier : verrouillé tant que la clé du gardien n'est pas ramassée.
  if (!state.stairsLocked) {
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player' || !a.alive || a.downed) continue
      if (Math.hypot(a.x - (state.stairs.x + 0.5), a.y - (state.stairs.y + 0.5)) < 0.6) {
        descend(state)
        break
      }
    }
  }

  state.rng = rng.s
  return { visible }
}
