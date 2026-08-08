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
import type {
  Actor,
  GameState,
  GroundItem,
  PlayerInput,
  Projectile,
  SpeciesDef,
  WeaponDef,
} from './types.js'
import {
  ACTOR_RADIUS,
  AGGRO_MAX_DIST,
  ATTACK_SWING,
  BLEED_OUT_TICKS,
  BOSS_ATK_MULT,
  BOSS_EVERY,
  BOSS_HP_MULT,
  BOSS_SPECIES,
  BOSS_WEIGHT_MULT,
  BOSS_XP_MULT,
  CORRIDOR_SPAWN_SHARE,
  DOWNED_SPEED,
  DT,
  ELITE_ATK_MULT,
  ELITE_HP_MULT,
  ELITE_WEIGHT_MULT,
  ELITE_XP_MULT,
  FLOOR_ATK_GROWTH,
  FLOOR_COOLDOWN_MIN,
  FLOOR_COOLDOWN_TIGHTEN,
  FLOOR_HP_GROWTH,
  FLOOR_XP_GROWTH,
  FOV_RADIUS,
  HEART_HEAL_MIN,
  HEART_HEAL_RATIO,
  KB_STACK_FALLOFF,
  KB_STACK_RESET,
  KNOCKBACK_DECAY,
  LOOT_WEAPONS,
  MONSTERS,
  MONSTER_BASE_COUNT,
  MONSTER_HALF_ARC,
  MONSTER_MAX_COUNT,
  MONSTER_PER_FLOOR,
  PACK_MAX,
  PACK_MIN,
  PACK_SPREAD,
  PICKUP_RANGE,
  PLAYER_BASE_HP,
  PLAYER_SPEED,
  PROJECTILE_RADIUS,
  PURSUE_DELAY,
  PURSUE_INTERVAL,
  PURSUE_MAX,
  PURSUE_STRIKE_GRACE,
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
  floorScale,
  mitigation,
  playerAttackMult,
  playerMaxHp,
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

/**
 * Vitesse effective d'un joueur : ramper quand on est à terre, et ralentir
 * pendant qu'on frappe.
 *
 * La pénalité est passée en argument plutôt que lue sur l'acteur parce que le
 * client prédit son propre coup avec sa propre horloge : il doit pouvoir
 * appliquer exactement la même règle sans tick serveur sous la main.
 */
export function playerSpeed(actor: { downed?: boolean }, movePenalty = 1): number {
  const base = actor.downed ? DOWNED_SPEED : PLAYER_SPEED
  return base * movePenalty
}

/** Arme portée, avec repli sur celle de départ si l'identifiant est inconnu. */
export function weaponOf(id: string | undefined): WeaponDef {
  return WEAPONS[id ?? STARTING_WEAPON] ?? WEAPONS[STARTING_WEAPON]!
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
  const rankHp = rank === 'boss' ? BOSS_HP_MULT : rank === 'elite' ? ELITE_HP_MULT : 1
  const rankAtk = rank === 'boss' ? BOSS_ATK_MULT : rank === 'elite' ? ELITE_ATK_MULT : 1
  // Les statistiques montent avec l'étage : sans ça un squelette de l'étage 12
  // a exactement les points de vie de celui de l'étage 1 pendant que le héros a
  // triplé les siens, et on traverse le donjon sans jamais être inquiété.
  const hpMult = rankHp * floorScale(state.floor, FLOOR_HP_GROWTH)
  const atkMult = rankAtk * floorScale(state.floor, FLOOR_ATK_GROWTH)
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

/**
 * Tuiles de couloir : praticables et hors de toute salle. On garde une distance
 * de sécurité au spawn — se faire cueillir avant d'avoir bougé n'est pas de la
 * difficulté.
 */
function corridorTiles(state: GameState, rooms: Rect[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let y = 1; y < state.height - 1; y++) {
    for (let x = 1; x < state.width - 1; x++) {
      if (state.tiles[y * state.width + x] !== Tile.Floor) continue
      if (Math.abs(x - state.spawn.x) + Math.abs(y - state.spawn.y) < 12) continue
      if (rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue
      out.push({ x, y })
    }
  }
  return out
}

function populate(state: GameState, rooms: Rect[], rng: Rng): void {
  const pool = monsterPool(state.floor)
  const count = Math.min(
    MONSTER_MAX_COUNT,
    MONSTER_BASE_COUNT + state.floor * MONSTER_PER_FLOOR,
  )
  // On exclut la salle de spawn : arriver au milieu d'un comité d'accueil
  // n'est pas une difficulté, c'est une frustration.
  const spawnable = rooms.slice(1)
  if (spawnable.length === 0) return

  // Les archers et les chargeurs sont ceux qui rendent un couloir terrifiant :
  // on ne peut ni les contourner ni reculer sans se faire rattraper. On les
  // place là en priorité.
  const corridorPool = pool.filter((s) => {
    const b = MONSTERS[s]!.behavior
    return b === 'archer' || b === 'charger'
  })
  const corridors = rng.shuffle(corridorTiles(state, rooms))
  const inCorridors = corridors.length ? Math.round(count * CORRIDOR_SPAWN_SHARE) : 0

  // On pose des meutes, pas des monstres un par un. Rencontrés isolément ils ne
  // menacent jamais personne, quels que soient leurs points de vie ; c'est le
  // nombre simultané qui force à décider.
  let placed = 0
  let index = 0
  while (placed < count) {
    const inCorridor = placed < inCorridors && corridors.length > 0
    const size = Math.min(count - placed, rng.range(PACK_MIN, PACK_MAX))

    let ax: number
    let ay: number
    let packPool: string[]
    if (inCorridor) {
      const tile = corridors[index % corridors.length]!
      ax = tile.x + 0.5
      ay = tile.y + 0.5
      packPool = corridorPool.length ? corridorPool : pool
    } else {
      const room = rng.pick(spawnable)
      ax = room.x + rng.int(room.w) + 0.5
      ay = room.y + rng.int(room.h) + 0.5
      packPool = pool
    }

    for (let k = 0; k < size; k++) {
      const angle = rng.next() * Math.PI * 2
      const radius = rng.next() * PACK_SPREAD
      const x = ax + Math.cos(angle) * radius
      const y = ay + Math.sin(angle) * radius
      index++
      if (!isFree(state, x, y)) continue
      spawnMonster(state, `m${state.floor}_${index}`, rng.pick(packPool), x, y, 'normal', rng)
    }
    placed += size
    index++
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
    dropItem(state, { kind: 'chest', x, y })
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
    pursuers: [],
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

  // Ce qu'on n'a pas tué nous suit. On garde en priorité les plus proches de
  // l'escalier : ce sont ceux qui nous collaient réellement, et ça laisse au
  // joueur un moyen de choisir sa dette — décrocher avant de descendre.
  const survivors = Object.values(state.actors)
    .filter((a) => a.kind === 'monster' && a.alive)
    .sort(
      (a, b) =>
        Math.hypot(a.x - state.stairs.x, a.y - state.stairs.y) -
        Math.hypot(b.x - state.stairs.x, b.y - state.stairs.y),
    )
    .slice(0, PURSUE_MAX)

  state.pursuers = survivors.map((actor, i) => {
    actor.kx = 0
    actor.ky = 0
    actor.swingUntil = 0
    actor.kbStacks = 0
    delete actor.windupUntil
    delete actor.dashUntil
    delete actor.kbStackAt
    return { atTick: state.tick + PURSUE_DELAY + i * PURSUE_INTERVAL, actor }
  })

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
  if (state.pursuers.length > 0) {
    state.events.push({ t: 'pursuit', count: state.pursuers.length })
  }
}

/**
 * Fait déboucher les poursuivants dus, au pied de l'escalier par lequel on est
 * arrivé. Ils sortent là et nulle part ailleurs : une menace qui apparaît à un
 * endroit connu se joue, une menace qui apparaît n'importe où se subit.
 */
function releasePursuers(state: GameState): void {
  if (state.pursuers.length === 0) return

  const due = state.pursuers.filter((p) => state.tick >= p.atTick)
  if (due.length === 0) return
  state.pursuers = state.pursuers.filter((p) => state.tick < p.atTick)

  for (const { actor } of due) {
    const spot = findFreeSpot(state, state.spawn.x + 0.5, state.spawn.y + 0.5)
    actor.x = spot.x
    actor.y = spot.y
    // Sans ce délai, un monstre qui avait fini de récupérer à l'étage du dessus
    // frappe dans la seconde où il apparaît, sans télégraphe visible.
    actor.readyAt = state.tick + PURSUE_STRIKE_GRACE
    state.actors[actor.id] = actor
    state.events.push({
      t: 'arrive',
      id: actor.id,
      species: actor.species,
      x: actor.x,
      y: actor.y,
    })
  }
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
    // Les joueurs ne se servent plus de `atk` : leur puissance est un facteur
    // dérivé du niveau. Le champ reste pour les monstres, qui l'utilisent.
    atk: 0,
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
      // Les PV se recalculent depuis le niveau plutôt que de s'accumuler : une
      // seule formule fait autorité, et changer HP_GROWTH corrige les
      // personnages existants au lieu de laisser des reliquats.
      const gained = playerMaxHp(level) - player.maxHp
      player.maxHp += gained
      // Si un réglage de HP_GROWTH baisse rétroactivement le palier, on ne tue
      // pas le personnage au passage de niveau.
      player.hp = Math.max(1, Math.min(player.maxHp, player.hp + gained))
      state.events.push({ t: 'levelup', id: player.id, level, x: player.x, y: player.y })
    }
    player.level = level
  }
}

/**
 * Unique point de création d'un objet au sol. Passer par ici garantit que
 * l'événement `drop` est toujours émis : c'est lui qui permet de mesurer ce qui
 * tombe, y compris ce qui est ramassé dans le tick même.
 */
function dropItem(state: GameState, item: Omit<GroundItem, 'id'>): void {
  state.items.push({ id: `i${state.nextId++}`, ...item })
  state.events.push({ t: 'drop', kind: item.kind, x: item.x, y: item.y })
}

function dropLoot(state: GameState, victim: Actor, rng: Rng): void {
  const def = MONSTERS[victim.species]
  const rank = victim.boss ? BOSS_XP_MULT : victim.elite ? ELITE_XP_MULT : 1
  // L'XP suit la difficulté de l'étage, sinon descendre ne rapporte plus rien
  // dès que la courbe de niveaux se raidit.
  const xp = Math.round((def?.xp ?? 3) * rank * floorScale(state.floor, FLOOR_XP_GROWTH))
  dropItem(state, { kind: 'xp', x: victim.x, y: victim.y, amount: xp })

  if (victim.elite || victim.boss) {
    dropItem(state, { kind: 'key', x: victim.x, y: victim.y })
    state.events.push({ t: 'keydrop', x: victim.x, y: victim.y })
    // Un porteur de clé lâche aussi de quoi encaisser la suite.
    dropItem(state, { kind: 'heart', x: victim.x + 0.5, y: victim.y })
    dropItem(state, { kind: 'heart', x: victim.x - 0.5, y: victim.y })
    if (victim.boss) {
      dropItem(state, {
        kind: 'weapon',
        x: victim.x, y: victim.y + 0.6, weapon: rng.pick(LOOT_WEAPONS),
      })
    }
  } else if (rng.chance(0.16)) {
    dropItem(state, { kind: 'heart', x: victim.x, y: victim.y })
  }
}

function killOrDown(state: GameState, victim: Actor, rng: Rng): void {
  // Les appelants testent `hp <= 0` après avoir appelé `damage()`, qui ignore
  // silencieusement les cibles déjà à terre — or un joueur à terre est
  // précisément à 0 PV. Sans cette garde, chaque coup porté vers lui le
  // remettait à terre : le compte à rebours de saignement repartait de zéro et
  // il ne mourait jamais.
  if (!victim.alive || victim.downed) return

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
  state.events.push({ t: 'death', id: victim.id, kind: victim.kind, species: victim.species, x: victim.x, y: victim.y })
  dropLoot(state, victim, rng)
  delete state.actors[victim.id]
}

/**
 * Recul encaissé, poids et rendements décroissants compris.
 *
 * Le premier coup projette franchement — c'est ce qui rend une hache
 * satisfaisante. Les suivants, tant qu'on enchaîne sur la même cible, poussent
 * de moins en moins. Sans ça n'importe quelle arme maintient éternellement un
 * monstre hors de portée et le jeu se résume à avancer en cliquant.
 */
function knockbackPush(state: GameState, to: Actor, strength: number): number {
  const rankWeight = to.boss ? BOSS_WEIGHT_MULT : to.elite ? ELITE_WEIGHT_MULT : 1
  const weight = (to.kind === 'player' ? 1 : (MONSTERS[to.species]?.weight ?? 1)) * rankWeight

  if (to.kbStackAt === undefined || state.tick - to.kbStackAt > KB_STACK_RESET) {
    to.kbStacks = 0
  }
  const stacks = to.kbStacks ?? 0
  to.kbStacks = stacks + 1
  to.kbStackAt = state.tick

  return strength / weight / (1 + stacks * KB_STACK_FALLOFF)
}

function damage(
  state: GameState,
  from: Actor | null,
  to: Actor,
  amount: number,
  knockback: number,
  originX: number,
  originY: number,
  /** Espèce à imputer quand la source n'existe plus — une flèche sans archer. */
  fromSpecies = from?.species ?? '',
): void {
  if (!to.alive) return
  // Un joueur déjà à terre n'est plus une cible : le finir en boucle n'apporte
  // rien qu'une frustration.
  if (to.kind === 'player' && to.downed) return
  if (to.invulnUntil !== undefined && state.tick < to.invulnUntil) return

  // Réduction par l'armure. Sans armure c'est l'identité — le chemin existe
  // pour que les armures s'ajoutent sans retoucher au modèle d'équilibrage.
  amount = Math.max(1, Math.round(amount * (1 - mitigation(to.armor ?? 0))))
  to.hp -= amount
  const push = knockbackPush(state, to, knockback)
  const ang = Math.atan2(to.y - originY, to.x - originX)
  to.kx += Math.cos(ang) * push
  to.ky += Math.sin(ang) * push

  state.events.push({
    t: 'hit',
    from: from?.id ?? '',
    fromSpecies,
    to: to.id,
    toSpecies: to.species,
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
    ownerSpecies: owner.species,
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
  const weapon = weaponOf(actor.weapon)
  actor.readyAt = state.tick + weapon.cooldown
  actor.swingUntil = state.tick + weapon.swing
  state.events.push({
    t: 'swing',
    id: actor.id,
    x: actor.x,
    y: actor.y,
    aim: actor.aim,
    reach: weapon.reach,
    halfArc: weapon.halfArc,
  })

  // Multiplicatif : l'écart entre deux armes se conserve à tous les niveaux.
  const dmg = Math.max(1, Math.round(weapon.damage * playerAttackMult(actor.level ?? 1)))

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
  state.events.push({ t: 'death', id: m.id, kind: m.kind, species: m.species, x: m.x, y: m.y })
  dropLoot(state, m, rng)
  delete state.actors[m.id]
}

/**
 * Cadence d'attaque d'un monstre à cet étage. On resserre le temps de
 * récupération avec la profondeur, jamais le temps de préparation : le
 * télégraphe doit rester aussi lisible à l'étage 20 qu'au premier, sinon la
 * difficulté cesse d'être juste.
 */
function monsterCooldown(state: GameState, def: SpeciesDef): number {
  const tighten = Math.max(
    FLOOR_COOLDOWN_MIN,
    1 - FLOOR_COOLDOWN_TIGHTEN * Math.max(0, state.floor - 1),
  )
  return Math.max(4, Math.round(def.cooldown * tighten))
}

function monsterStrike(state: GameState, m: Actor, rng: Rng): void {
  const def = MONSTERS[m.species]!
  m.readyAt = state.tick + monsterCooldown(state, def)
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
      damage(state, owner, target, p.damage, p.knockback, p.x, p.y, p.ownerSpecies)
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
        nearest.hp = Math.min(
          nearest.maxHp,
          nearest.hp + Math.max(HEART_HEAL_MIN, Math.round(nearest.maxHp * HEART_HEAL_RATIO)),
        )
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
        dropItem(state, {
        kind: 'weapon',
          x: item.x, y: item.y, weapon: previous, lockedFor: nearest.id,
        })
        break
      }

      case 'chest': {
        // Le contenu est verrouillé pour celui qui ouvre : il voit ce qui est
        // tombé avant de décider de changer d'arme, au lieu de subir l'échange.
        dropItem(state, {
        kind: 'weapon',
          x: item.x, y: item.y, weapon: rng.pick(LOOT_WEAPONS), lockedFor: nearest.id,
        })
        dropItem(state, { kind: 'heart', x: item.x + 0.7, y: item.y })
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
      state.events.push({ t: 'death', id: a.id, kind: 'player', species: a.species, x: a.x, y: a.y })
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

  // 0. Les poursuivants de l'étage précédent débouchent de l'escalier.
  releasePursuers(state)

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
    // On frappe d'abord, puis on bouge : le coup engage donc dès ce tick-ci.
    // Frapper et fuir dans le même souffle n'est plus possible.
    if (input.attack && !actor.downed && state.tick >= actor.readyAt) {
      playerAttack(state, actor, rng)
    }

    const weapon = weaponOf(actor.weapon)
    movePhysical(
      state.tiles, state.width, state.height, actor,
      input.mx, input.my,
      playerSpeed(actor, state.tick < actor.swingUntil ? weapon.movePenalty : 1),
    )
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
        m.readyAt = state.tick + monsterCooldown(state, def)
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
