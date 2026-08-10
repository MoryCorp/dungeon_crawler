/**
 * Cœur du jeu : création d'état et fonction de pas.
 *
 * `step()` reste déterministe et sans effet de bord externe. Le client réutilise
 * `movePhysical()` pour prédire son propre déplacement — même code des deux
 * côtés, donc la prédiction ne peut pas diverger pour cause de règles
 * différentes.
 */
import { buildFlowField, decideMonsterAction } from './ai.js'
import { createDirector, updateDirector } from './director.js'
import { profileOf } from './profile.js'
import { pickRecipe, recordReward, warmStart } from './bandit.js'
import { planWave, recipesFor, type Placement } from './recipes.js'
import { computeFov } from './fov.js'
import {
  generateBossFloor,
  generateFloor,
  generateSasFloor,
  type Rect,
  type Room,
} from './mapgen.js'
import { hitsBody, inAttackArc, moveWithCollision, separateActors, solidAt, unstick } from './physics.js'
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
  AGGRO_MEMORY,
  BANDIT_HURT_WEIGHT,
  BANDIT_WINDOW,
  ATTACK_SWING,
  BLEED_OUT_TICKS,
  BOSS_ATK_MULT,
  BOSS_EVERY,
  BOSS_HP_MULT,
  BOSS_WEIGHT_MULT,
  BOSS_XP_MULT,
  CORRIDOR_SPAWN_SHARE,
  DIRECTOR_ENGAGE_RANGE,
  DIRECTOR_RESERVE,
  DOWNED_SPEED,
  DT,
  ELITE_ATK_MULT,
  ELITE_HP_MULT,
  ELITE_WEIGHT_MULT,
  ELITE_XP_MULT,
  FLOOR_ATK_GROWTH,
  monsterCooldownAt,
  FLOOR_HP_GROWTH,
  FLOW_MAX_DIST,
  FLOOR_XP_GROWTH,
  FOV_RADIUS,
  CARRIED_OF_CAP,
  HEART_DROP_CHANCE,
  healCapOf,
  WEAR_LOW_HP,
  REST_STRAIN,
  REST_MIN_GAP,
  CAP_BONUS_STEP,
  capPrice,
  soinPrice,
  FIOLE_PRICE,
  HASTE_MULT,
  HASTE_TICKS,
  FRESH_TICKS,
  TRAP_BONE_REWARD,
  TRAP_WARNING_TICKS,
  trapWaveSize,
  BONE_PER_KILL,
  BONE_ELITE,
  BONE_BOSS,
  chestPrice,
  HEART_HEAL_MIN,
  HEART_HEAL_RATIO,
  RESPAWN_OF_CAP,
  REVIVE_OF_CAP,
  healCap,
  HORDE_MAX,
  HORDE_MAX_DIST,
  HORDE_MIN,
  HORDE_MIN_DIST,
  HORDE_SPREAD,
  KB_STACK_FALLOFF,
  KB_STACK_RESET,
  KNOCKBACK_DECAY,
  LOOT_WEAPONS,
  MONSTERS,
  MONSTER_HALF_ARC,
  PACK_MAX,
  PACK_MIN,
  PACK_SPREAD,
  PICKUP_RANGE,
  PLACED_BASE_COUNT,
  PLACED_MAX_COUNT,
  PLACED_PER_FLOOR,
  PLAYER_BASE_HP,
  PLAYER_SPEED,
  ROLL_BUFFER,
  ROLL_COOLDOWN,
  ROLL_COST,
  ROLL_IFRAMES,
  ROLL_MIN_STAMINA,
  ROLL_SPEED,
  ROLL_TICKS,
  SPRINT_DRAIN,
  SPRINT_MIN_START,
  SPRINT_MULT,
  SPRINT_REFILL_DELAY,
  SPRINT_REGEN,
  SQUAD_PATIENCE,
  STAGGER_IMMUNITY,
  STAGGER_KNOCKBACK_MIN,
  STAGGER_RECOVER,
  PROFILE_EMA_ALPHA,
  BODY_HEIGHT,
  PROJECTILE_RADIUS,
  TAKE_BUFFER,
  PURSUE_MAX,
  PURSUE_STRIKE_GRACE,
  RECIPE_FAR_MIN,
  RECIPE_FLANK_HALF_ARC,
  RECIPE_FRONT_MIN_SPEED,
  RECIPE_NEAR_MAX,
  RESPAWN_GRACE,
  RESPAWN_TICKS,
  REVIVE_RANGE,
  REVIVE_TICKS,
  STARTING_WEAPON,
  TICK_RATE,
  Tile,
  WEAPONS,
  isWalkable,
  XP_MAGNET_RANGE,
  XP_MAGNET_SPEED,
  biomeOf,
  floorInAct,
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
export function playerSpeed(
  actor: { downed?: boolean },
  movePenalty = 1,
  sprinting = false,
  hasted = false,
): number {
  const base = actor.downed ? DOWNED_SPEED : PLAYER_SPEED
  return base * movePenalty * (sprinting ? SPRINT_MULT : 1) * (hasted ? HASTE_MULT : 1)
}

/**
 * Fait tourner la jauge de sprint et dit si la course s'applique ce tick.
 *
 * Pure et sans RNG : le client rejoue exactement la même fonction pour prédire
 * son propre déplacement, avec sa jauge recalée sur celle du serveur à chaque
 * paquet. On ne sprinte pas la lame sortie — sinon le sprint deviendrait une
 * façon de frapper en fuyant, ce que le coût de déplacement des armes existe
 * précisément pour interdire.
 */
export function stepSprint(
  actor: Pick<Actor, 'downed' | 'stamina' | 'sprinting' | 'sprintedAt' | 'freshUntil'>,
  tick: number,
  wants: boolean,
  moving: boolean,
  swinging: boolean,
): boolean {
  const stamina = actor.stamina ?? 1
  const asked = wants && moving && !swinging && !actor.downed
  // On relance au-dessus du seuil, on poursuit tant qu'il reste du souffle :
  // sans cette distinction, la jauge vide provoquerait un sprint haché.
  const sprinting = asked && (actor.sprinting === true ? stamina > 0 : stamina >= SPRINT_MIN_START)

  if (sprinting) {
    // Fiole de souffle : la jauge ne se vide pas tant que l'effet dure.
    const fresh = (actor.freshUntil ?? 0) > tick
    actor.stamina = fresh ? stamina : Math.max(0, stamina - SPRINT_DRAIN * DT)
    actor.sprintedAt = tick
  } else if (tick - (actor.sprintedAt ?? -SPRINT_REFILL_DELAY) >= SPRINT_REFILL_DELAY) {
    actor.stamina = Math.min(1, stamina + SPRINT_REGEN * DT)
  } else {
    actor.stamina = stamina
  }
  actor.sprinting = sprinting
  return sprinting
}

/**
 * Démarre ou poursuit une roulade. Pure et sans RNG, comme `stepSprint`, et
 * pour la même raison : le client prédit sa propre roulade avec exactement ce
 * code — la divergence ne peut venir que de la latence, jamais des règles.
 *
 * Le déplacement lui-même reste à la charge de l'appelant (il faut la carte
 * pour l'arrêt au mur). Retourne `'start'` au tick de départ — c'est là que le
 * serveur émet l'événement — `'roll'` tant que ça roule, `null` sinon.
 *
 * La direction est celle du déplacement demandé, la visée en secours : on
 * roule où l'on va, pas où l'on regarde. Le coût passe par la jauge de sprint
 * — rouler, c'est renoncer à courir — et la fiole de souffle rend la roulade
 * gratuite comme elle rend le sprint inépuisable. Le temps mort, lui, tient
 * même sous fiole : sinon elle transformerait la roulade en téléportation
 * continue.
 *
 * Elle coupe le geste d'attaque en cours. Le coup a déjà porté — les dégâts
 * partent au tick de la frappe, la suite n'est que récupération — donc annuler
 * cette récupération ne vole rien à personne, et c'est ce qui rend la commande
 * fiable : sans ça, un joueur qui tient le clic passe un tiers du temps
 * incapable de rouler, sans jamais comprendre pourquoi.
 */
export function stepRoll(
  actor: Pick<
    Actor,
    | 'downed' | 'stamina' | 'freshUntil' | 'invulnUntil'
    | 'rollUntil' | 'rollVx' | 'rollVy' | 'rolledAt' | 'rollWantAt' | 'sprintedAt'
  >,
  tick: number,
  wants: boolean,
  mx: number,
  my: number,
  aim: number,
): 'start' | 'roll' | null {
  if (actor.rollUntil !== undefined) {
    if (tick < actor.rollUntil && !actor.downed) return 'roll'
    delete actor.rollUntil
  }
  if (wants) actor.rollWantAt = tick
  const asked = tick - (actor.rollWantAt ?? -ROLL_BUFFER - 1) < ROLL_BUFFER
  if (!asked || actor.downed) return null
  if (tick - (actor.rolledAt ?? -ROLL_TICKS - ROLL_COOLDOWN) < ROLL_TICKS + ROLL_COOLDOWN) return null

  const stamina = actor.stamina ?? 1
  const fresh = (actor.freshUntil ?? 0) > tick
  if (!fresh && stamina < ROLL_MIN_STAMINA) return null
  delete actor.rollWantAt

  let dx = mx
  let dy = my
  if (dx === 0 && dy === 0) {
    dx = Math.cos(aim)
    dy = Math.sin(aim)
  }
  const len = Math.hypot(dx, dy)
  actor.rollVx = dx / len
  actor.rollVy = dy / len
  actor.rollUntil = tick + ROLL_TICKS
  actor.rolledAt = tick
  actor.invulnUntil = Math.max(actor.invulnUntil ?? 0, tick + ROLL_IFRAMES)
  if (!fresh) actor.stamina = Math.max(0, stamina - ROLL_COST)
  // La jauge ne remonte qu'après le même temps mort que le sprint.
  actor.sprintedAt = tick
  return 'start'
}

/** Arme portée, avec repli sur celle de départ si l'identifiant est inconnu. */
export function weaponOf(id: string | undefined): WeaponDef {
  return WEAPONS[id ?? STARTING_WEAPON] ?? WEAPONS[STARTING_WEAPON]!
}

// ---------------------------------------------------------------- peuplement

/** Rang atteint par l'échelle du biome à cet étage (voir monsterPool). */
function garrisonDepth(floor: number, ladderLength: number): number {
  return Math.min(Math.max(floorInAct(floor) - 1, 1), ladderLength)
}

// Exporté pour curve.ts : la courbe d'XP doit compter les espèces qu'un étage
// pose réellement, pas la moyenne de tout le bestiaire boss compris.
export function monsterPool(floor: number): string[] {
  const biome = biomeOf(floor)
  if (biome.ladder.length === 0) {
    // Le cachot historique, seul biome sans échelle propre.
    const pool = ['skeleton', 'bat']
    if (floor >= 2) pool.push('orc', 'orc_rogue')
    if (floor >= 3) pool.push('skeleton_mage', 'skeleton_rogue')
    if (floor >= 4) pool.push('skeleton_warrior', 'orc_bomber')
    if (floor >= 6) pool.push('orc_warrior', 'orc_mage')
    return pool
  }
  // La garnison monte d'un archétype par étage, en retard d'un cran : les deux
  // premiers étages de l'acte n'ont que la troupe de base — le rythme du
  // cachot, où les mages n'arrivaient qu'à l'étage 3. Le socle est doublé dans
  // le tirage : quatre espèces au lieu de six rendraient sinon les tireurs
  // deux fois plus denses qu'au cachot, et c'est la densité de tir qui tue
  // (mesuré en vraie partie : 72 % des dégâts subis). Aux premiers étages, les
  // recettes qui exigent un archétype absent dégradent en mêlée via planWave —
  // c'est la douceur voulue à l'entrée d'un acte, pas un accident.
  const depth = garrisonDepth(floor, biome.ladder.length)
  return [biome.swarm, biome.ladder[0]!, ...biome.ladder.slice(0, depth)]
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

function populate(state: GameState, rooms: Room[], rng: Rng): void {
  const pool = monsterPool(state.floor)
  const count = Math.min(PLACED_MAX_COUNT, PLACED_BASE_COUNT + state.floor * PLACED_PER_FLOOR)

  // La réserve est un simple compteur : c'est la recette qui décidera des
  // espèces au moment de livrer, pas le peuplement.
  state.reserveCount = DIRECTOR_RESERVE
  // On exclut la salle de spawn : arriver au milieu d'un comité d'accueil
  // n'est pas une difficulté, c'est une frustration. Ni la salle piégée (son
  // contenu, c'est le piège), ni la salle de repos (la Directrice s'y tait,
  // le peuplement aussi).
  const spawnable = rooms.slice(1).filter((r) => r.kind !== 'tresor' && r.kind !== 'repos')
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
  // Dans un biome à échelle, le gardien vient des rangs déjà connus :
  // l'archétype qui débute à cet étage sert dans la troupe avant de mériter
  // l'élite. Sinon l'élite du nouveau venu fait un pic que rien n'annonce —
  // mesuré au botrun, un chevalier d'élite à l'étage 3 bloquait la descente.
  const biome = biomeOf(state.floor)
  const veterans = biome.ladder.length
    ? biome.ladder.slice(0, Math.max(1, garrisonDepth(state.floor, biome.ladder.length) - 1))
    : pool
  const keeperPool = veterans.filter((s) => MONSTERS[s]!.behavior !== 'swarm')
  const keeperRoom = spawnable[spawnable.length - 1]!
  const kx = keeperRoom.x + Math.floor(keeperRoom.w / 2) + 0.5
  const ky = keeperRoom.y + Math.floor(keeperRoom.h / 2) + 0.5
  spawnMonster(
    state,
    `keeper${state.floor}`,
    rng.pick(keeperPool.length ? keeperPool : pool),
    kx,
    ky,
    'elite',
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

  // La salle piégée : la récompense est posée au centre, visible depuis la
  // porte — une arme, des cœurs, un tas d'ossements. Le piège s'arme, et tout
  // le reste se joue dans stepTrap().
  const treasure = rooms.find((r) => r.kind === 'tresor')
  if (treasure) {
    const tx = treasure.x + Math.floor(treasure.w / 2) + 0.5
    const ty = treasure.y + Math.floor(treasure.h / 2) + 0.5
    dropItem(state, { kind: 'weapon', x: tx, y: ty, weapon: rng.pick(LOOT_WEAPONS) })
    dropItem(state, { kind: 'heart', x: tx - 0.8, y: ty + 0.6 })
    dropItem(state, { kind: 'heart', x: tx + 0.8, y: ty + 0.6 })
    dropItem(state, { kind: 'bone', x: tx, y: ty - 0.7, amount: TRAP_BONE_REWARD })
    state.trap = { room: treasure, phase: 'armed', gates: [] }
  }

  placeStall(state, rooms)
}

// L'étal de la salle de repos : quatre objets posés au sol, prix affichés,
// achat en marchant dessus. La Directrice muette et l'absence de monstres
// font le reste — la salle EST le répit, l'étal n'est que la dépense.
function placeStall(state: GameState, rooms: Room[]): void {
  const rest = rooms.find((r) => r.kind === 'repos')
  if (rest) {
    // Dans le SAS (la salle repos EST celle du spawn), le centre est le point
    // d'arrivée de toute l'équipe : un étal posé là se ferait acheter avant le
    // premier input. Les articles s'alignent donc contre le mur haut, sous le
    // marchand — hors du chemin, mais visibles d'un coup d'œil en arrivant.
    const sasStall = rest === rooms[0]
    const rx = rest.x + Math.floor(rest.w / 2) + 0.5
    const ry = sasStall ? rest.y + 1.5 : rest.y + Math.floor(rest.h / 2) + 0.5
    // Chaque article est ramené sur une tuile praticable : dans une petite
    // salle, un offset fixe depuis le centre peut tomber dans le mur — l'objet
    // devient alors inachetable pour tout le monde (mesuré : des fioles à
    // −1 de tout champ de distance, l'étal mort pour toute la descente).
    const spots = sasStall
      ? [
          { kind: 'cap' as const, x: rx - 1.5, y: ry, price: capPrice(state.capBought) },
          { kind: 'soin' as const, x: rx - 0.5, y: ry, price: soinPrice(state.floor) },
          { kind: 'fiole_souffle' as const, x: rx + 0.5, y: ry, price: FIOLE_PRICE },
          { kind: 'fiole_vitesse' as const, x: rx + 1.5, y: ry, price: FIOLE_PRICE },
        ]
      : [
          { kind: 'cap' as const, x: rx, y: ry, price: capPrice(state.capBought) },
          { kind: 'soin' as const, x: rx - 1.4, y: ry, price: soinPrice(state.floor) },
          { kind: 'fiole_souffle' as const, x: rx + 1.4, y: ry, price: FIOLE_PRICE },
          { kind: 'fiole_vitesse' as const, x: rx + 1.4, y: ry + 1, price: FIOLE_PRICE },
        ]
    for (const s of spots) {
      const at = findFreeSpot(state, s.x, s.y)
      dropItem(state, { kind: s.kind, x: at.x, y: at.y, price: s.price })
    }
    // Le coffre du SAS : une arme à prix d'étage, pour repartir équipé dans
    // l'acte qui s'ouvre. Payant comme tous les coffres. Ancré au coin de la
    // salle : à droite de l'étal, il déborderait d'un petit SAS et se
    // retrouverait sans protection dans le couloir.
    if (sasStall) {
      const at = findFreeSpot(state, rest.x + 0.5, rest.y + 1.5)
      dropItem(state, { kind: 'chest', x: at.x, y: at.y })
    }
  }
}

// Le SAS : aucun monstre, aucune réserve — la Directrice n'a rien à livrer.
// L'étal et le coffre suffisent ; le sanctuaire est une pause, pas un étage.
function populateSas(state: GameState, rooms: Room[]): void {
  state.reserveCount = 0
  placeStall(state, rooms)
}

// L'arène : le Gardien seul, au fond, face à l'entrée. Pas de réserve non
// plus — ses renforts sont les siens, appelés par ses propres seuils de vie,
// pas par la Directrice.
function populateBoss(state: GameState, rooms: Room[], rng: Rng): void {
  state.reserveCount = 0
  const arena = rooms[0]!
  const bx = arena.x + arena.w - 5.5
  const by = arena.y + Math.floor(arena.h / 2) + 0.5
  spawnMonster(state, `keeper${state.floor}`, biomeOf(state.floor).boss, bx, by, 'boss', rng)
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
    reserveCount: 0,
    director: createDirector(0, seed),
    profiles: {},
    bandit: {},
    floorKills: 0,
    bones: 0,
    rooms: layout.rooms,
    decor: layout.decor,
    capBonus: 0,
    capBought: 0,
    wear: { lowTicks: 0, ticks: 0, downs: 0 },
    events: [],
  }

  populate(state, layout.rooms, rng)
  state.rng = rng.s
  return state
}

export function descend(state: GameState): void {
  const rng = new Rng(state.rng)

  // La salle de repos se mérite : décidée sur l'état au moment de prendre
  // l'escalier, jamais au rythme d'un métronome. Le signal lent la justifie,
  // l'écart minimal empêche deux repos coup sur coup même en pleine déroute.
  const restDue =
    slowStrain(state) >= REST_STRAIN &&
    state.floor + 1 - (state.lastRestFloor ?? -REST_MIN_GAP) > REST_MIN_GAP

  // Patience : part de l'étage qu'on vient de quitter réellement tuée. Créditée
  // à toute l'équipe présente — descendre est une décision de groupe, celui qui
  // suit l'assume autant que celui qui appuie.
  const remaining =
    Object.values(state.actors).filter((a) => a.kind === 'monster' && a.alive).length +
    state.reserveCount
  const cleared = state.floorKills / Math.max(1, state.floorKills + remaining)
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player') continue
    const prof = profileOf(state, a.id)
    prof.clearedSum += cleared
    prof.floorsSeen += 1
  }
  state.floorKills = 0

  // La vague en cours d'évaluation disparaît avec l'étage : on solde son
  // levier avec ce qu'elle a produit jusqu'ici.
  settleBandit(state)

  // Le palier de boss, tous les BOSS_EVERY étages : l'escalier de l'étage 4
  // de l'acte mène au SAS (le sanctuaire marchand), celui du SAS mène à
  // l'arène, celui de l'arène ouvre l'acte suivant. SAS et arène partagent le
  // numéro de l'étage de boss — on « passe de 4 à 6 », avec un temps au milieu.
  const from = state.scene
  let scene: GameState['scene']
  if (state.scene === 'sas') {
    scene = 'boss'
  } else if (state.scene === 'boss') {
    scene = undefined
    state.floor += 1
  } else if (floorInAct(state.floor + 1) === BOSS_EVERY) {
    scene = 'sas'
    state.floor += 1
  } else {
    scene = undefined
    state.floor += 1
  }
  const layout =
    scene === 'sas' ? generateSasFloor()
    : scene === 'boss' ? generateBossFloor()
    : generateFloor(rng, state.floor)
  if (scene) state.scene = scene
  else delete state.scene

  state.tiles = layout.tiles
  state.width = layout.width
  state.height = layout.height
  state.stairs = layout.stairs
  state.spawn = layout.spawn
  // Le SAS ne se verrouille pas : continuer est un choix, pas une quête.
  state.stairsLocked = scene !== 'sas'
  state.projectiles = []
  state.items = []
  state.rooms = layout.rooms
  state.decor = layout.decor
  delete state.trap
  delete state.restAnnounced
  if (scene === 'sas') {
    // Le SAS est un repos : l'écart minimal du repos organique repart d'ici.
    state.lastRestFloor = state.floor
  }

  // La salle de repos : la plus proche du spawn parmi les convenables — un
  // repos qu'on découvre à la fin de l'étage n'aurait servi à rien.
  if (restDue && !scene) {
    const candidates = layout.rooms.filter(
      (r) =>
        r.kind !== 'tresor' &&
        r !== layout.rooms[0] &&
        !insideRoom(r, layout.stairs.x, layout.stairs.y) &&
        r.w >= 5 && r.h >= 5,
    )
    let restRoom: Room | null = null
    let bestD = Infinity
    for (const r of candidates) {
      const d = Math.hypot(r.x + r.w / 2 - layout.spawn.x, r.y + r.h / 2 - layout.spawn.y)
      if (d < bestD) {
        bestD = d
        restRoom = r
      }
    }
    if (restRoom) {
      restRoom.kind = 'repos'
      state.lastRestFloor = state.floor
    }
  }

  // Ce qu'on n'a pas tué nous suit. On garde en priorité les plus proches de
  // l'escalier : ce sont ceux qui nous collaient réellement, et ça laisse au
  // joueur un moyen de choisir sa dette — décrocher avant de descendre.
  // Le palier de boss solde tout : personne ne poursuit une équipe dans le
  // sanctuaire, et les gardes appelés par le Gardien meurent avec leur arène.
  const survivors = scene === undefined && from === undefined
    ? Object.values(state.actors)
        .filter((a) => a.kind === 'monster' && a.alive)
        .sort(
          (a, b) =>
            Math.hypot(a.x - state.stairs.x, a.y - state.stairs.y) -
            Math.hypot(b.x - state.stairs.x, b.y - state.stairs.y),
        )
        .slice(0, PURSUE_MAX)
    : []

  state.pursuers = survivors.map((actor) => {
    actor.kx = 0
    actor.ky = 0
    actor.swingUntil = 0
    actor.kbStacks = 0
    delete actor.windupUntil
    delete actor.dashUntil
    delete actor.kbStackAt
    return { actor }
  })
  state.director = createDirector(state.tick, state.seed)

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
      // Le chemin le moins cher doit rendre le moins : sans ça, se laisser
      // mettre à terre juste avant l'escalier était le soin le plus rentable
      // du jeu — ni les huit secondes de réapparition, ni le saignement.
      a.hp = standUpHp(state, a, CARRIED_OF_CAP)
    }
    a.invulnUntil = state.tick + RESPAWN_GRACE
  }

  if (scene === 'sas') populateSas(state, layout.rooms)
  else if (scene === 'boss') populateBoss(state, layout.rooms, rng)
  else populate(state, layout.rooms, rng)
  state.rng = rng.s
  state.events.push({ t: 'descend', floor: state.floor })
  if (state.pursuers.length > 0) {
    state.events.push({ t: 'pursuit', count: state.pursuers.length })
  }
}

/**
 * Accumulation du profil de style à chaque déplacement d'un joueur debout.
 *
 * `dx/dy` est le déplacement réel — murs, glissements et recul compris. Le
 * recul encaissé compte donc comme du mouvement : c'est voulu, être ballotté en
 * combat fait partie de la façon dont on le vit.
 */
function profileMovement(
  state: GameState,
  actor: Actor,
  threats: Actor[],
  dx: number,
  dy: number,
): void {
  const prof = profileOf(state, actor.id)
  prof.moveX += (dx - prof.moveX) * PROFILE_EMA_ALPHA
  prof.moveY += (dy - prof.moveY) * PROFILE_EMA_ALPHA

  const engaged = threats.some(
    (m) => Math.hypot(m.x - actor.x, m.y - actor.y) <= DIRECTOR_ENGAGE_RANGE,
  )
  if (!engaged) return

  prof.combatMoveSum += Math.hypot(dx, dy)
  prof.combatTicks += 1
  prof.fleeX += (dx - prof.fleeX) * PROFILE_EMA_ALPHA
  prof.fleeY += (dy - prof.fleeY) * PROFILE_EMA_ALPHA

  // Cohésion : à quelle distance du coéquipier le plus proche on se bat. Les
  // ticks solo ne comptent pas — une moyenne polluée de parties jouées seul ne
  // dirait rien du style, seulement de la fréquentation.
  let nearest = Infinity
  for (const other of Object.values(state.actors)) {
    if (other.kind !== 'player' || other.id === actor.id || !other.alive || other.downed) continue
    nearest = Math.min(nearest, Math.hypot(other.x - actor.x, other.y - actor.y))
  }
  if (nearest < Infinity) {
    prof.allyDistSum += nearest
    prof.allyTicks += 1
  }
}

/**
 * Lecture des événements du tick pour le profil : portée des coups infligés,
 * encombrement au moment d'encaisser. Appelée après les projectiles — les
 * touches à l'arc du tick font partie du tick — et sur la même liste
 * d'événements que la Directrice.
 */
function updateProfilesFromEvents(state: GameState): void {
  for (const ev of state.events) {
    if (ev.t !== 'hit') continue

    if (ev.fromSpecies === 'hero') {
      // L'événement porte la position de la victime ; l'attaquant joueur est
      // encore dans l'état au même tick — sauf s'il vient de se déconnecter,
      // auquel cas la mesure saute, pas le tick.
      const attacker = state.actors[ev.from]
      if (attacker?.kind === 'player') {
        const prof = profileOf(state, attacker.id)
        prof.hitDistSum += Math.hypot(attacker.x - ev.x, attacker.y - ev.y)
        prof.hitCount += 1
      }
    }

    if (ev.toSpecies === 'hero') {
      const victim = state.actors[ev.to]
      if (victim?.kind === 'player') {
        let near = 0
        for (const m of Object.values(state.actors)) {
          if (m.kind !== 'monster' || !m.alive) continue
          if (Math.hypot(m.x - victim.x, m.y - victim.y) <= DIRECTOR_ENGAGE_RANGE) near++
        }
        const prof = profileOf(state, victim.id)
        prof.crowdSum += near
        prof.hitsTakenCount += 1
      }
    }
  }
}

/**
 * Solde la fenêtre d'évaluation d'une vague : gain = pic d'intensité ET dégâts
 * réellement encaissés, pondérés. L'intensité seule se laisse gonfler par le
 * simple nombre de corps autour du joueur (mesuré : harcèlement notée 70 %
 * pour 0.3 dégât par monstre) ; les dégâts subis ne mentent pas.
 */
function settleBandit(state: GameState): void {
  const pending = state.banditPending
  if (!pending) return
  const hurt = Math.min(1, pending.hurt * 3)
  const reward = pending.peak * (1 - BANDIT_HURT_WEIGHT) + hurt * BANDIT_HURT_WEIGHT
  recordReward((state.bandit[pending.id] ??= {}), pending.recipe, reward)
  delete state.banditPending
}

/**
 * Rassemble ce que la Directrice observe, puis applique sa décision.
 *
 * L'intensité se lit sur les événements du tick précédent : ce sont eux qui
 * portent les dégâts subis et les mises à terre, et ils sont déjà là.
 */
/**
 * Le signal lent : l'usure de la descente entière, en 0 (frais) — 1 (laminé).
 * Trois composantes, toutes cumulées depuis l'étage 1 : les PV que le plafond
 * ne permet plus de regagner, le temps passé sous le seuil critique, les mises
 * à terre. Il ne déclenche jamais rien — il biaise la boucle rapide et décide
 * si la prochaine salle de repos est méritée.
 */
export function slowStrain(state: GameState): number {
  let best = 0
  let players = 0
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive || a.maxHp <= 0) continue
    players++
    best = Math.max(best, a.hp / a.maxHp)
  }
  if (players === 0) return 0
  // Les PV non regagnés se mesurent à la barre PLEINE, pas au plafond : le
  // plafond est précisément ce qui rend cet écart irrécupérable — le mesurer
  // relativement au plafond faisait qu'un joueur remonté pile au plafond
  // comptait pour frais, même à 75 % de sa barre. (Vu sur la partie TEST11 :
  // usure réelle 100 → 77 %, signal lent figé à zéro, aucun repos proposé.)
  const hpGap = Math.max(0, 1 - best)
  const low = state.wear.lowTicks / Math.max(1, state.wear.ticks)
  const downs = Math.min(1, state.wear.downs / (3 * players))
  return Math.min(1, 0.45 * hpGap + 0.35 * low + 0.2 * downs)
}

function runDirector(state: GameState, visible: Uint8Array, rng: Rng): void {
  const players = Object.values(state.actors).filter(
    (a) => a.kind === 'player' && a.alive && !a.downed,
  )

  // L'usure s'accumule ici, au même rythme pour tout le monde : des
  // ticks-joueur, dont ceux passés sous le seuil critique.
  for (const p of players) {
    state.wear.ticks++
    if (p.hp / p.maxHp < WEAR_LOW_HP) state.wear.lowTicks++
  }

  let damageFraction = 0
  let downed = false
  for (const ev of state.events) {
    if (ev.t === 'downed') downed = true
    if (ev.t !== 'hit') continue
    const victim = state.actors[ev.to]
    if (victim?.kind !== 'player' || victim.maxHp <= 0) continue
    damageFraction = Math.max(damageFraction, ev.dmg / victim.maxHp)
  }

  let engaged = 0
  for (const p of players) {
    let near = 0
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'monster' || !a.alive) continue
      if (Math.hypot(a.x - p.x, a.y - p.y) <= DIRECTOR_ENGAGE_RANGE) near++
    }
    engaged = Math.max(engaged, near)
  }

  // Personne de vivant sur ses jambes : la Directrice n'a plus de munitions.
  // Livrer sur une équipe déjà à terre ne produit pas de la tension, ça
  // s'acharne — et le dire ici plutôt qu'après coup lui évite de dépenser sa
  // patience pour une décision qu'on va jeter.
  const available = players.length > 0 ? state.pursuers.length + state.reserveCount : 0
  const wanted = updateDirector(state.director, state.tick, {
    damageFraction,
    engaged,
    downed,
    available,
    strain: slowStrain(state),
  })

  // Fenêtre d'évaluation de la dernière vague. À l'échéance, son gain
  // s'inscrit au levier de la recette — c'est comme ça que la Directrice
  // apprend.
  const pending = state.banditPending
  if (pending) {
    pending.peak = Math.max(pending.peak, state.director.intensity)
    // Attribution causale : seuls comptent les coups portés À la cible de la
    // vague PAR ses escouades. Avant, une vague visant Alice était créditée
    // du monstre posé qui frappait Bob — le carnet apprenait du bruit. Un
    // auteur disparu du registre (mort avant l'impact de sa flèche) compte
    // aussi : c'est presque toujours un membre de la vague qu'on vient de
    // tuer, jamais un joueur.
    let waveFraction = 0
    for (const ev of state.events) {
      if (ev.t !== 'hit' || ev.to !== pending.target) continue
      const victim = state.actors[ev.to]
      if (victim?.kind !== 'player' || victim.maxHp <= 0) continue
      const from = state.actors[ev.from]
      const fromWave = from
        ? from.squad !== undefined && pending.squads.includes(from.squad)
        : ev.fromSpecies !== 'hero' && ev.fromSpecies !== ''
      if (!fromWave) continue
      waveFraction = Math.max(waveFraction, ev.dmg / victim.maxHp)
    }
    pending.hurt += waveFraction
    if (state.tick >= pending.until) settleBandit(state)
  }

  if (wanted > 0) deliverHorde(state, wanted, visible, rng)
  stepTrap(state, rng)

  // Le répit s'annonce en le découvrant : la Directrice se tait ici, et le
  // joueur doit le savoir — un calme qu'on croit menacé n'est pas un repos.
  if (!state.restAnnounced) {
    const rest = state.rooms.find((r) => r.kind === 'repos')
    if (rest && players.some((p) => insideRoom(rest, p.x, p.y))) {
      state.restAnnounced = true
      state.events.push({ t: 'rest', x: rest.x + rest.w / 2, y: rest.y + rest.h / 2 })
    }
  }
}

/**
 * Choisit où poser un groupe : hors de vue, praticable, dans une bande de
 * distance mesurée à la cible, et — si la recette l'exige — dans un secteur
 * angulaire autour d'elle.
 *
 * Hors de vue est la contrainte importante. Des monstres qui apparaissent sous
 * les yeux du joueur cassent la fiction et transforment une vague en tricherie
 * visible ; les mêmes monstres qui débouchent d'un couloir sont une rencontre.
 *
 * Les contraintes se relâchent en cascade plutôt que d'échouer : d'abord sans
 * le secteur angulaire, puis sur la bande standard. Une recette contrariée par
 * la carte doit dégénérer en vague ordinaire, jamais en absence de vague.
 */
function recipeAnchor(
  state: GameState,
  visible: Uint8Array,
  rng: Rng,
  target: Actor,
  opts: { minDist: number; maxDist: number; dir?: number; halfArc?: number },
): { x: number; y: number; degraded: boolean } | null {
  const sample = (
    minDist: number,
    maxDist: number,
    dir?: number,
    halfArc?: number,
  ): { x: number; y: number } | null => {
    let best: { x: number; y: number; score: number } | null = null
    // Un échantillon suffit : on cherche un bon emplacement, pas le meilleur.
    for (let tries = 0; tries < 220; tries++) {
      const x = 1 + rng.int(state.width - 2)
      const y = 1 + rng.int(state.height - 2)
      const idx = y * state.width + x
      if (!isWalkable(state.tiles[idx]!)) continue
      if (visible[idx]) continue

      const dist = Math.hypot(target.x - x, target.y - y)
      if (dist < minDist || dist > maxDist) continue

      if (dir !== undefined && halfArc !== undefined) {
        const angle = Math.atan2(y - target.y, x - target.x)
        let delta = angle - dir
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        if (Math.abs(delta) > halfArc) continue
      }

      // À contraintes égales, on préfère le plus proche : la vague doit arriver
      // pendant que le joueur est encore là, pas trois salles plus loin.
      const score = -dist
      if (!best || score > best.score) best = { x, y, score }
    }
    return best ? { x: best.x + 0.5, y: best.y + 0.5 } : null
  }

  // Le niveau de repli est une mesure, pas un détail : c'est la part des
  // demandes de recette que la carte actuelle refuse — la géométrie typée
  // doit la faire baisser, et sans chiffre d'avant il n'y a pas de chantier.
  const asAsked = sample(opts.minDist, opts.maxDist, opts.dir, opts.halfArc)
  if (asAsked) return { ...asAsked, degraded: false }
  // Sans secteur c'est un repli ; sans secteur demandé, une simple relance.
  const noSector = sample(opts.minDist, opts.maxDist)
  if (noSector) return { ...noSector, degraded: opts.dir !== undefined }
  const anyBand = sample(HORDE_MIN_DIST, HORDE_MAX_DIST)
  return anyBand ? { ...anyBand, degraded: true } : null
}

/** Bande de distance et secteur d'un placement de recette, pour cette cible. */
function placementOpts(
  state: GameState,
  target: Actor,
  placement: Placement,
  flankAngle: number,
): { minDist: number; maxDist: number; dir?: number; halfArc?: number } {
  switch (placement) {
    case 'near':
      return { minDist: HORDE_MIN_DIST, maxDist: RECIPE_NEAR_MAX }
    case 'far':
      return { minDist: RECIPE_FAR_MIN, maxDist: HORDE_MAX_DIST }
    case 'flankA':
      return {
        minDist: HORDE_MIN_DIST,
        maxDist: HORDE_MAX_DIST,
        dir: flankAngle,
        halfArc: RECIPE_FLANK_HALF_ARC,
      }
    case 'flankB':
      return {
        minDist: HORDE_MIN_DIST,
        maxDist: HORDE_MAX_DIST,
        dir: flankAngle + Math.PI,
        halfArc: RECIPE_FLANK_HALF_ARC,
      }
    case 'front': {
      // Couper la route : devant la direction de déplacement récente de la
      // cible. Sans direction nette (joueur à l'arrêt), il n'y a rien à couper.
      const prof = state.profiles[target.id]
      const speed = prof ? Math.hypot(prof.moveX, prof.moveY) * TICK_RATE : 0
      if (prof && speed >= RECIPE_FRONT_MIN_SPEED) {
        return {
          minDist: HORDE_MIN_DIST,
          maxDist: HORDE_MAX_DIST,
          dir: Math.atan2(prof.moveY, prof.moveX),
          halfArc: RECIPE_FLANK_HALF_ARC,
        }
      }
      return { minDist: HORDE_MIN_DIST, maxDist: HORDE_MAX_DIST }
    }
    case 'standard':
      return { minDist: HORDE_MIN_DIST, maxDist: HORDE_MAX_DIST }
  }
}

/**
 * Livre une vague selon une recette tirée au hasard — uniforme pour l'instant :
 * on veut de la variété et des échantillons, l'adaptation au style viendra.
 *
 * La cible est le joueur le mieux portant : c'est lui qui donne le tempo de
 * l'équipe, et c'est contre lui que la vague doit compter. La dette de l'étage
 * précédent passe en premier, quelle que soit la recette — ce qu'on a laissé
 * en vie ne revient plus en file indienne à un endroit qu'on peut camper, il
 * revient en groupe, au moment où on ne s'y attend pas.
 */
function deliverHorde(state: GameState, count: number, visible: Uint8Array, rng: Rng): void {
  // Le biais de cible est assumé et gardé : la vague vise le joueur le mieux
  // portant. C'est lui qui donne le tempo de l'équipe, et viser le plus
  // faible transformerait chaque vague en curée — la Directrice fabrique de
  // la tension, pas des exécutions. Ce biais est documenté ici parce qu'il
  // est invisible dans les chiffres : le bandit apprend PAR cible, donc ses
  // carnets décrivent toujours ce qui marche contre un joueur en forme.
  // La salle de repos : la Directrice s'y tait — pour ceux qui s'y trouvent.
  // Un joueur au sanctuaire sort de la SÉLECTION, il ne protège pas les
  // autres : avant, le mieux portant planqué au repos coupait toutes les
  // vagues pour l'équipe entière (mesuré à l'audit — exploit structurel).
  const restRoom = state.rooms.find((r) => r.kind === 'repos')
  let target: Actor | null = null
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive || a.downed || a.maxHp <= 0) continue
    if (restRoom && insideRoom(restRoom, a.x, a.y)) continue
    if (!target || a.hp / a.maxHp > target.hp / target.maxHp) target = a
  }
  // Toute l'équipe au repos : là oui, la Directrice se tait vraiment.
  if (!target) return

  // Une vague part avant la fin de la fenêtre de la précédente : on solde la
  // précédente avec ce qui a été observé jusqu'ici plutôt que de lui
  // attribuer l'intensité de celle qui arrive.
  settleBandit(state)

  // La mémoire du bandit est contextuelle : par joueur ET par arme portée.
  // Ce qui marche contre un joueur à la dague ne dit rien contre le même
  // joueur à l'arc — changer d'arme ouvre un carnet neuf, que l'UCB remplit
  // en quelques vagues, sans polluer ni perdre le carnet précédent.
  const context = `${target.id}:${target.weapon ?? 'sword'}`
  // Le bandit ne choisit que parmi les recettes jouables là où est la cible :
  // le type de la salle filtre, le couloir plus encore.
  const targetRoom = state.rooms.find((r) => insideRoom(r, target.x, target.y))
  // Carnet neuf ? Démarrage à chaud depuis les carnets des autres armes du
  // même joueur, décoté à n = 1 (voir warmStart).
  const arms = state.bandit[context] ?? (state.bandit[context] = warmStart(state.bandit, target.id))
  const recipe = pickRecipe(arms, rng, recipesFor(targetRoom?.kind ?? 'couloir'))
  const stock = state.pursuers.length + state.reserveCount
  const total = Math.min(stock, Math.max(1, Math.round(count * recipe.sizeMult)))
  if (total <= 0) return

  const owed = new Map<string, number>()
  for (const p of state.pursuers) {
    owed.set(p.actor.species, (owed.get(p.actor.species) ?? 0) + 1)
  }
  const plan = planWave(recipe, total, monsterPool(state.floor), owed, rng)

  // Le même axe pour les deux flancs d'une tenaille : c'est l'opposition qui
  // fait la prise, pas deux directions au hasard.
  const flankAngle = rng.next() * Math.PI * 2

  let placed = 0
  let groupsPlaced = 0
  let groupsDegraded = 0
  // Distance de livraison réalisée : sans elle, impossible de savoir si un
  // réglage du placement a réellement changé où tombent les vagues.
  let distSum = 0
  let eventAnchor: { x: number; y: number } | null = null
  // Une escouade par groupe, pas par vague : les deux mâchoires d'une tenaille
  // arrivent de deux côtés opposés et n'ont aucune raison de s'attendre l'une
  // l'autre — chacune doit arriver entière, c'est tout.
  let squadIndex = 0
  // Les escouades livrées, mémorisées pour l'attribution : la fenêtre du
  // bandit ne créditera que les coups portés par CES monstres-là.
  const squads: string[] = []
  for (const group of plan) {
    // L'étage dans l'identifiant : deux runs au même tick (restart) ne
    // doivent jamais partager une chaîne d'escouade.
    const squad = `s${state.floor}_${state.tick}_${squadIndex++}`
    squads.push(squad)
    const anchor = recipeAnchor(
      state, visible, rng, target,
      placementOpts(state, target, group.placement, flankAngle),
    )
    // Pas d'emplacement pour ce groupe : sa part reste en stock pour la
    // prochaine vague, dette comprise.
    if (!anchor) continue
    groupsPlaced++
    if (anchor.degraded) groupsDegraded++
    distSum += Math.hypot(anchor.x - target.x, anchor.y - target.y)
    eventAnchor ??= anchor

    const groupSize = group.fromDebt + group.fromReserve
    let debtLeft = group.fromDebt
    for (let i = 0; i < groupSize; i++) {
      const angle = rng.next() * Math.PI * 2
      const radius = rng.next() * HORDE_SPREAD
      const spot = findFreeSpot(
        state,
        anchor.x + Math.cos(angle) * radius,
        anchor.y + Math.sin(angle) * radius,
      )

      let actor: Actor | null = null
      if (debtLeft > 0) {
        const at = state.pursuers.findIndex((p) => p.actor.species === group.species)
        if (at >= 0) {
          actor = state.pursuers.splice(at, 1)[0]!.actor
          actor.x = spot.x
          actor.y = spot.y
          state.actors[actor.id] = actor
          debtLeft--
        }
      }
      if (!actor) {
        if (state.reserveCount <= 0) break
        state.reserveCount--
        actor = spawnMonster(
          state,
          `d${state.floor}_${state.nextId++}`,
          group.species,
          spot.x,
          spot.y,
          'normal',
          rng,
        )
      }

      // Sans ce délai, un monstre qui avait fini de récupérer frappe dans la
      // seconde où il apparaît, sans télégraphe visible.
      actor.readyAt = state.tick + PURSUE_STRIKE_GRACE
      // Livrés déjà en chasse : une vague qui flâne n'est plus une vague.
      actor.aggroUntil = state.tick + AGGRO_MEMORY * 4
      // Et livrés solidaires : ils avancent au rythme du plus lent des leurs.
      actor.squad = squad
      actor.squadUntil = state.tick + SQUAD_PATIENCE
      placed++
    }
  }

  if (placed > 0 && eventAnchor) {
    state.events.push({
      t: 'horde',
      count: placed,
      x: eventAnchor.x,
      y: eventAnchor.y,
      recipe: recipe.name,
      groups: plan.length,
      placed: groupsPlaced,
      degraded: groupsDegraded,
      dist: Math.round((distSum / groupsPlaced) * 10) / 10,
    })
    // La fenêtre s'ouvre : ce que cette vague produit s'inscrira à son levier.
    state.banditPending = {
      id: context,
      recipe: recipe.name,
      until: state.tick + BANDIT_WINDOW,
      peak: 0,
      hurt: 0,
      target: target.id,
      squads,
    }
  }
}

const insideRoom = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

/**
 * La salle piégée, phase par phase. Armée : entrer allume les braseros et
 * annonce la grille — 1,5 s pour ressortir, le pari se refuse. Ressortis à
 * temps : le piège se réarme, rien n'est perdu. Restés dedans : la grille
 * tombe, une vague composée par la Directrice apparaît DANS la salle — hors
 * réserve, c'est du contenu en plus, pas un emprunt sur les vagues normales.
 * Salle vide de monstres : la grille se relève, définitivement.
 */
function stepTrap(state: GameState, rng: Rng): void {
  const trap = state.trap
  if (!trap || trap.phase === 'done') return
  const room = trap.room
  const cx = room.x + room.w / 2
  const cy = room.y + room.h / 2

  const playersInside = Object.values(state.actors).filter(
    (a) => a.kind === 'player' && a.alive && insideRoom(room, a.x, a.y),
  )

  if (trap.phase === 'armed') {
    if (playersInside.length > 0) {
      trap.phase = 'warning'
      trap.closeAt = state.tick + TRAP_WARNING_TICKS
      state.events.push({ t: 'trapwarn', x: cx, y: cy })
    }
    return
  }

  if (trap.phase === 'warning') {
    if (state.tick < (trap.closeAt ?? 0)) return
    if (playersInside.length === 0) {
      // Sortis à temps : pari refusé, le piège se réarme sans rancune.
      trap.phase = 'armed'
      delete trap.closeAt
      return
    }
    // La grille tombe : toutes les tuiles franchissables du pourtour immédiat.
    for (let y = room.y - 1; y <= room.y + room.h; y++) {
      for (let x = room.x - 1; x <= room.x + room.w; x++) {
        const onRing = x < room.x || x >= room.x + room.w || y < room.y || y >= room.y + room.h
        if (!onRing || x < 0 || y < 0 || x >= state.width || y >= state.height) continue
        const idx = y * state.width + x
        if (state.tiles[idx] === Tile.Floor || state.tiles[idx] === Tile.Door) {
          state.tiles[idx] = Tile.Gate
          trap.gates.push({ x, y })
        }
      }
    }
    state.events.push({ t: 'trapclose', x: cx, y: cy })

    // La vague, composée comme n'importe quelle vague : recette du bandit
    // (contexte du joueur le mieux portant dans la salle), groupes mono-espèce.
    const target = playersInside.reduce((b, a) => (a.hp / a.maxHp > b.hp / b.maxHp ? a : b))
    const context = `${target.id}:${target.weapon ?? 'sword'}`
    // Même chemin d'apprentissage que les vagues normales : démarrage à chaud
    // du carnet, et une fenêtre d'évaluation ouverte plus bas. Avant, le
    // piège tirait sur un carnet vide et n'inscrivait jamais son résultat —
    // le bandit ne savait rien de ses vagues piégées.
    const arms = state.bandit[context] ?? (state.bandit[context] = warmStart(state.bandit, target.id))
    const recipe = pickRecipe(arms, rng)
    const plan = planWave(recipe, trapWaveSize(state.floor), monsterPool(state.floor), new Map(), rng)
    const trapSquads: string[] = []
    for (const group of plan) {
      const squad = `t${state.floor}_${state.tick}_${group.placement}`
      trapSquads.push(squad)
      for (let i = 0; i < group.fromDebt + group.fromReserve; i++) {
        // Dans la salle, mais jamais collé à un joueur : le monstre apparaît
        // à au moins deux tuiles, sinon le premier coup part sans télégraphe.
        let sx = cx
        let sy = cy
        for (let tries = 0; tries < 30; tries++) {
          const x = room.x + 0.5 + rng.next() * (room.w - 1)
          const y = room.y + 0.5 + rng.next() * (room.h - 1)
          if (!isWalkableAt(state, x, y)) continue
          if (playersInside.some((p) => Math.hypot(p.x - x, p.y - y) < 2)) continue
          sx = x
          sy = y
          break
        }
        const spot = findFreeSpot(state, sx, sy)
        const actor = spawnMonster(
          state, `t${state.floor}_${state.nextId++}`, group.species, spot.x, spot.y, 'normal', rng,
        )
        actor.readyAt = state.tick + PURSUE_STRIKE_GRACE
        actor.aggroUntil = state.tick + AGGRO_MEMORY * 4
        actor.squad = squad
        actor.squadUntil = state.tick + SQUAD_PATIENCE
      }
    }
    // La fenêtre du piège remplace toute fenêtre en cours : on solde d'abord.
    settleBandit(state)
    state.banditPending = {
      id: context,
      recipe: recipe.name,
      until: state.tick + BANDIT_WINDOW,
      peak: 0,
      hurt: 0,
      target: target.id,
      squads: trapSquads,
    }
    trap.phase = 'sprung'
    return
  }

  // sprung : la grille tient tant qu'il reste un monstre dans la salle.
  const monstersInside = Object.values(state.actors).some(
    (a) => a.kind === 'monster' && a.alive && insideRoom(room, a.x, a.y),
  )
  if (!monstersInside) {
    for (const g of trap.gates) state.tiles[g.y * state.width + g.x] = Tile.Floor
    trap.gates = []
    trap.phase = 'done'
    state.events.push({ t: 'trapclear', x: cx, y: cy })
  }
}

export function addPlayer(state: GameState, id: string, name: string): Actor {
  const existing = state.actors[id]
  if (existing) return existing
  // Le profil, lui, survit aux allers-retours : il décrit le joueur, pas la session.
  profileOf(state, id)

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

  // Les ossements : tout ce qui meurt en laisse. Pas d'indexation sur
  // l'étage — c'est le prix des choses qui monte, pas la récolte, sinon la
  // monnaie n'exprime plus l'effort mais la profondeur.
  const bones = victim.boss ? BONE_BOSS : victim.elite ? BONE_ELITE : BONE_PER_KILL
  dropItem(state, { kind: 'bone', x: victim.x - 0.4, y: victim.y + 0.3, amount: bones })

  if (victim.elite || victim.boss) {
    dropItem(state, { kind: 'key', x: victim.x, y: victim.y })
    state.events.push({ t: 'keydrop', x: victim.x, y: victim.y })
    // Un porteur de clé lâche aussi de quoi encaisser la suite.
    dropItem(state, { kind: 'heart', x: victim.x + 0.5, y: victim.y })
    if (victim.boss) {
      dropItem(state, {
        kind: 'weapon',
        x: victim.x, y: victim.y + 0.6, weapon: rng.pick(LOOT_WEAPONS),
      })
    }
  } else if (rng.chance(HEART_DROP_CHANCE)) {
    dropItem(state, { kind: 'heart', x: victim.x, y: victim.y })
  }
}

/**
 * PV rendus en se remettant debout, à la fraction du plafond de soin qui
 * correspond au chemin emprunté. Un seul endroit pour les trois façons de se
 * relever : elles étaient écrites en dur à trois points différents du fichier,
 * et l'ordre entre elles s'était inversé sans que personne le voie.
 */
function standUpHp(state: GameState, actor: Actor, ofCap: number): number {
  return Math.max(1, Math.round(actor.maxHp * healCapOf(state) * ofCap))
}

function killOrDown(state: GameState, victim: Actor, rng: Rng): void {
  // Les appelants testent `hp <= 0` après avoir appelé `damage()`, qui ignore
  // silencieusement les cibles déjà à terre — or un joueur à terre est
  // précisément à 0 PV. Sans cette garde, chaque coup porté vers lui le
  // remettait à terre : le compte à rebours de saignement repartait de zéro et
  // il ne mourait jamais.
  if (!victim.alive || victim.downed) return

  if (victim.kind === 'player') {
    // Personne d'autre debout : la mise à terre serait une agonie sans issue
    // (aucune mécanique d'auto-relevage). Mort sèche, et l'événement `wipe`
    // dit au serveur que la partie est finie — en solo comme en équipe.
    const someoneStanding = Object.values(state.actors).some(
      (a) => a.kind === 'player' && a.id !== victim.id && a.alive && !a.downed,
    )
    if (!someoneStanding) {
      victim.hp = 0
      victim.alive = false
      victim.downed = false
      victim.reviveProgress = 0
      victim.kx = 0
      victim.ky = 0
      delete victim.windupUntil
      delete victim.bleedOutAt
      victim.respawnAt = state.tick + RESPAWN_TICKS
      // La mise à terre est émise quand même : c'est elle qui porte le
      // « qui t'a eu » dans la télémétrie, mort sèche ou pas.
      state.wear.downs++
      state.events.push({ t: 'downed', id: victim.id, x: victim.x, y: victim.y })
      state.events.push({ t: 'death', id: victim.id, kind: 'player', species: victim.species, x: victim.x, y: victim.y })
      state.events.push({ t: 'wipe', floor: state.floor })
      return
    }

    // Mise à terre plutôt que mort sèche : un coéquipier peut encore le sauver.
    victim.hp = 0
    victim.downed = true
    victim.reviveProgress = 0
    victim.bleedOutAt = state.tick + BLEED_OUT_TICKS
    victim.kx = 0
    victim.ky = 0
    delete victim.windupUntil
    state.wear.downs++
    state.events.push({ t: 'downed', id: victim.id, x: victim.x, y: victim.y })
    return
  }

  victim.hp = 0
  victim.alive = false
  state.floorKills += 1
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

  // Le coup encaissé fait manquer l'attaque en préparation. Réservé aux coups
  // portés par un joueur : deux monstres qui se blessent entre eux (l'explosion
  // du kamikaze) ne doivent pas désamorcer tout un groupe. Et il y faut du
  // poids : voir STAGGER_KNOCKBACK_MIN, une dague ne bouscule personne.
  if (
    to.kind === 'monster' &&
    !to.boss &&
    from?.kind === 'player' &&
    knockback >= STAGGER_KNOCKBACK_MIN &&
    to.windupUntil !== undefined &&
    state.tick < to.windupUntil &&
    state.tick >= (to.staggerReadyAt ?? 0)
  ) {
    delete to.windupUntil
    to.readyAt = state.tick + STAGGER_RECOVER
    to.staggerReadyAt = state.tick + STAGGER_IMMUNITY
    state.events.push({ t: 'stagger', id: to.id, species: to.species, x: to.x, y: to.y })
  }

  // Une ruée frappée en plein vol se coupe net — même sanction que le mur :
  // le monstre s'arrête et reste vulnérable un instant. Pas d'étourdissement
  // en plus, le contre EST la récompense. Contrairement au stagger, ça vaut
  // aussi pour le boss et sans seuil de poids : c'est un coup au timing, pas
  // une bousculade — les chargeurs sont les premiers tueurs du relevé et
  // c'était le verbe qui manquait contre eux.
  if (
    to.kind === 'monster' &&
    from?.kind === 'player' &&
    to.dashUntil !== undefined &&
    state.tick < to.dashUntil
  ) {
    delete to.dashUntil
    to.readyAt = Math.max(to.readyAt, state.tick + monsterCooldown(state, MONSTERS[to.species]!))
    state.events.push({ t: 'dashbreak', id: to.id, species: to.species, x: to.x, y: to.y })
  }
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

  // Renvoi : un projectile hostile balayé par l'arc repart vers son tireur,
  // avec ses dégâts d'origine. C'est la réponse au mage qu'on cherchait sans
  // toucher à ses chiffres — le tir reste dangereux, mais il devient un pari
  // dans les deux sens. La fenêtre est le geste lui-même : il faut frapper le
  // projectile en vol, au timing, pas tenir une garde.
  for (const p of state.projectiles) {
    if (!p.hostileToPlayers) continue
    if (
      !inAttackArc(
        actor.x, actor.y, actor.aim,
        weapon.halfArc, weapon.reach,
        p.x, p.y, PROJECTILE_RADIUS + 0.15,
      )
    ) {
      continue
    }
    const shooter = state.actors[p.ownerId]
    const speed = Math.hypot(p.vx, p.vy)
    const back = shooter?.alive
      ? Math.atan2(shooter.y - p.y, shooter.x - p.x)
      : actor.aim
    p.vx = Math.cos(back) * speed
    p.vy = Math.sin(back) * speed
    p.hostileToPlayers = false
    p.ownerId = actor.id
    p.ownerSpecies = actor.species
    // Assez de vie pour retraverser la salle — un renvoi qui expire en vol
    // n'aurait l'air de rien.
    p.ttl = Math.max(p.ttl, 60)
    state.events.push({ t: 'parry', id: actor.id, x: p.x, y: p.y })
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
  // Le kamikaze meurt hors de killOrDown : il compte quand même pour l'étage.
  state.floorKills += 1
  state.events.push({ t: 'death', id: m.id, kind: m.kind, species: m.species, x: m.x, y: m.y })
  dropLoot(state, m, rng)
  delete state.actors[m.id]
}

/** Cadence d'attaque à cet étage — la formule vit dans monsterCooldownAt. */
function monsterCooldown(state: GameState, def: SpeciesDef): number {
  return monsterCooldownAt(state.floor, def)
}

/**
 * Les seuils de vie du Gardien : à 50 % puis 25 %, il appelle la garde — deux
 * soldats de l'échelle du biome, puis deux du rang suivant. Des renforts de
 * rang normal, jamais d'élite : la clé de l'arène, c'est lui et lui seul.
 * Un seul appel par seuil, même si un coup massif fait sauter les deux d'un
 * coup — le pattern doit rester lisible, pas s'empiler.
 */
function stepBossPhase(state: GameState, m: Actor, rng: Rng): void {
  const phase = m.hp <= m.maxHp * 0.25 ? 2 : m.hp <= m.maxHp * 0.5 ? 1 : 0
  if (phase <= (m.bossPhase ?? 0)) return
  m.bossPhase = phase
  const ladder = biomeOf(state.floor).ladder
  const species = (phase === 1 ? ladder[0] : ladder[1]) ?? monsterPool(state.floor)[0]!
  for (let k = 0; k < 2; k++) {
    const at = findFreeSpot(state, m.x + (k === 0 ? -2.5 : 2.5), m.y)
    spawnMonster(state, `garde${state.floor}_${phase}_${k}`, species, at.x, at.y, 'normal', rng)
  }
  state.events.push({ t: 'bossphase', id: m.id, phase, x: m.x, y: m.y })
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

    case 'colosse': {
      // Le pattern se choisit au moment de frapper, sur la distance réelle :
      // loin, la charge sismique — même verbe que le chargeur, même contre
      // possible en plein vol. Près, le martèlement : l'arc de mêlée, puis une
      // couronne de huit éclats de pierre qui punit de rester collé sans
      // regarder — chacun se pare ou s'esquive comme une flèche.
      let nearest = Infinity
      for (const target of Object.values(state.actors)) {
        if (target.kind !== 'player' || !target.alive || target.downed) continue
        nearest = Math.min(nearest, Math.hypot(target.x - m.x, target.y - m.y))
      }
      if (nearest > 3) {
        m.dashUntil = state.tick + (def.dashTicks ?? 12)
        m.dashVx = Math.cos(m.aim)
        m.dashVy = Math.sin(m.aim)
        return
      }
      state.events.push({
        t: 'swing', id: m.id, x: m.x, y: m.y, aim: m.aim, reach: 1.7, halfArc: MONSTER_HALF_ARC,
      })
      for (const target of Object.values(state.actors)) {
        if (!target.alive || target.kind !== 'player') continue
        if (
          !inAttackArc(
            m.x, m.y, m.aim,
            MONSTER_HALF_ARC, 1.7,
            target.x, target.y, ACTOR_RADIUS,
          )
        ) {
          continue
        }
        damage(state, m, target, m.atk, def.knockback, m.x, m.y)
        if (target.hp <= 0) killOrDown(state, target, rng)
      }
      const shardDmg = Math.max(1, Math.round(m.atk * 0.4))
      const shardSpeed = def.projectileSpeed ?? 6.5
      for (let k = 0; k < 8; k++) {
        spawnProjectile(
          state, m, (k * Math.PI) / 4,
          shardSpeed, shardDmg, def.knockback, Math.round((5 / shardSpeed) * TICK_RATE) + 10,
          def.color,
        )
      }
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
      // Capsule verticale à l'échelle du rang : la hitbox suit le sprite,
      // une flèche qui traverse visiblement un torse doit toucher.
      const bodyScale = target.boss ? 1.9 : target.elite ? 1.35 : 1
      if (!hitsBody(p.x, p.y, target.x, target.y, ACTOR_RADIUS + PROJECTILE_RADIUS, BODY_HEIGHT * bodyScale)) continue

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

    // Les orbes d'XP et les ossements viennent à toi : ramasser à la case
    // près n'est pas du jeu.
    if ((item.kind === 'xp' || item.kind === 'bone') && bestD < XP_MAGNET_RANGE) {
      const ang = Math.atan2(nearest.y - item.y, nearest.x - item.x)
      item.x += Math.cos(ang) * XP_MAGNET_SPEED * DT
      item.y += Math.sin(ang) * XP_MAGNET_SPEED * DT
    }

    const range = item.kind === 'chest' ? PICKUP_RANGE + 0.2 : PICKUP_RANGE
    if (Math.hypot(nearest.x - item.x, nearest.y - item.y) > range) continue

    // Une arme ne se ramasse que sur demande. Tout le reste continue de se
    // prendre en marchant dessus : l'or et les soins ne posent aucune question,
    // l'arme si — et la reprendre par accident en repassant dans un couloir
    // annulait une décision qu'on venait de prendre.
    if (item.kind === 'weapon') {
      if (state.tick - (nearest.takeAt ?? -TAKE_BUFFER - 1) > TAKE_BUFFER) continue
      delete nearest.takeAt
    }

    // Ce qui a un prix ne se prend que si l'équipe peut payer. Pas de message
    // d'erreur côté engine : le prix est affiché au-dessus de l'objet, un
    // objet qui reste au sol est une information, pas une panne.
    const price = item.kind === 'chest' ? chestPrice(state.floor) : item.price ?? 0
    if (price > 0 && state.bones < price) continue

    // À l'étal, on n'achète pas l'inutile en passant : un soin à pleine vie,
    // un plafond déjà au maximum, une fiole sans fente libre restent posés.
    if (item.kind === 'soin' && nearest.hp >= Math.round(nearest.maxHp * healCapOf(state))) continue
    if (item.kind === 'cap' && healCapOf(state) >= 1) continue
    if ((item.kind === 'fiole_souffle' || item.kind === 'fiole_vitesse') && nearest.potion !== undefined) continue

    if (price > 0) {
      state.bones -= price
      state.events.push({ t: 'spend', id: nearest.id, amount: price, what: item.kind, x: item.x, y: item.y })
    }

    switch (item.kind) {
      case 'xp':
        grantXp(state, item.amount ?? 1)
        break

      case 'bone':
        state.bones += item.amount ?? 1
        break

      case 'cap':
        // LE puits : remonter le plafond de soin, pour toute l'équipe et pour
        // le reste de la partie. Son prix monte à chaque achat.
        state.capBonus += CAP_BONUS_STEP
        state.capBought++
        break

      case 'soin':
        nearest.hp = Math.max(nearest.hp, Math.round(nearest.maxHp * healCapOf(state)))
        break

      case 'fiole_souffle':
        nearest.potion = 'souffle'
        break

      case 'fiole_vitesse':
        nearest.potion = 'vitesse'
        break

      case 'heart': {
        // Le plafond descend avec l'étage : un cœur soigne toujours, mais il ne
        // ramène plus aussi haut, et ce qu'on a perdu en profondeur ne se
        // rattrape pas sur place.
        const ceiling = Math.round(nearest.maxHp * healCapOf(state))
        if (nearest.hp >= ceiling) continue // on laisse le soin par terre
        nearest.hp = Math.min(
          ceiling,
          nearest.hp + Math.max(HEART_HEAL_MIN, Math.round(nearest.maxHp * HEART_HEAL_RATIO)),
        )
        break
      }

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
      amount: item.kind === 'bone' ? item.amount ?? 1 : undefined,
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
        a.hp = standUpHp(state, a, REVIVE_OF_CAP)
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
      a.hp = standUpHp(state, a, RESPAWN_OF_CAP)
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

  buildFlowField(state, flow, FLOW_MAX_DIST)

  // 3. Joueurs.
  // Les monstres n'ont pas encore bougé ce tick : le profil mesure l'engagement
  // à un tick près, ce qui ne change rien à une moyenne sur des minutes.
  const threats = Object.values(state.actors).filter((a) => a.kind === 'monster' && a.alive)
  for (const actor of Object.values(state.actors)) {
    if (actor.kind !== 'player' || !actor.alive) continue
    const input = inputs[actor.id]
    if (!input) {
      movePhysical(state.tiles, state.width, state.height, actor, 0, 0, 0)
      continue
    }

    actor.aim = input.aim
    if (input.take === true) actor.takeAt = state.tick

    // Roulade : elle consomme le tick entier — ni coup, ni fiole, ni sprint
    // tant qu'on roule. Le recul est écrasé (le verbe reprend le contrôle du
    // corps), et un mur pris de plein fouet la coupe net, comme la ruée des
    // monstres.
    const rolled = stepRoll(
      actor, state.tick, input.roll === true,
      input.mx, input.my, input.aim,
    )
    if (rolled !== null) {
      if (rolled === 'start') {
        // Le geste d'attaque est coupé : le coup a déjà porté, seule la
        // récupération saute.
        actor.swingUntil = state.tick
        state.events.push({ t: 'roll', id: actor.id, x: actor.x, y: actor.y })
      }
      const beforeX = actor.x
      const beforeY = actor.y
      actor.kx = 0
      actor.ky = 0
      movePhysical(
        state.tiles, state.width, state.height, actor,
        actor.rollVx ?? 0, actor.rollVy ?? 0, ROLL_SPEED,
      )
      const travelled = Math.hypot(actor.x - beforeX, actor.y - beforeY)
      if (travelled < ROLL_SPEED * DT * 0.4) delete actor.rollUntil
      profileMovement(state, actor, threats, actor.x - beforeX, actor.y - beforeY)
      continue
    }

    // On frappe d'abord, puis on bouge : le coup engage donc dès ce tick-ci.
    // Frapper et fuir dans le même souffle n'est plus possible.
    if (input.attack && !actor.downed && state.tick >= actor.readyAt) {
      playerAttack(state, actor, rng)
    }

    // Boire la fiole portée. Une seule fente, une décision : maintenant ou
    // jamais — l'effet est immédiat, la fente se libère.
    if (input.drink === true && !actor.downed && actor.potion !== undefined) {
      if (actor.potion === 'souffle') {
        actor.stamina = 1
        actor.freshUntil = state.tick + FRESH_TICKS
      } else {
        actor.hasteUntil = state.tick + HASTE_TICKS
      }
      state.events.push({ t: 'drink', id: actor.id, potion: actor.potion, x: actor.x, y: actor.y })
      delete actor.potion
    }

    const weapon = weaponOf(actor.weapon)
    const beforeX = actor.x
    const beforeY = actor.y
    const swinging = state.tick < actor.swingUntil
    const sprinting = stepSprint(
      actor, state.tick,
      input.sprint === true,
      input.mx !== 0 || input.my !== 0,
      swinging,
    )
    movePhysical(
      state.tiles, state.width, state.height, actor,
      input.mx, input.my,
      playerSpeed(actor, swinging ? weapon.movePenalty : 1, sprinting, (actor.hasteUntil ?? 0) > state.tick),
    )
    if (!actor.downed) {
      profileMovement(state, actor, threats, actor.x - beforeX, actor.y - beforeY)
    }
  }

  // 4. Monstres.
  //
  // Retard de chaque escouade avant de faire agir qui que ce soit : c'est la
  // distance du membre le plus loin de sa cible, mesurée sur le champ de flux
  // qu'on vient de reconstruire. Une seule passe, et tout le monde décide sur
  // la même photo — sinon le premier monstre de la boucle attendrait un
  // retardataire qui a déjà rattrapé son retard plus bas dans la même boucle.
  const squadLag = new Map<string, number>()
  for (const m of Object.values(state.actors)) {
    if (m.kind !== 'monster' || !m.alive || m.squad === undefined) continue
    if ((m.squadUntil ?? 0) <= state.tick) {
      delete m.squad
      delete m.squadUntil
      continue
    }
    const d = flow[Math.floor(m.y) * state.width + Math.floor(m.x)] ?? -1
    if (d < 0) continue
    const known = squadLag.get(m.squad)
    if (known === undefined || d > known) squadLag.set(m.squad, d)
  }

  for (const m of Object.values(state.actors)) {
    if (m.kind !== 'monster' || !m.alive) continue
    const def = MONSTERS[m.species]!

    if (m.boss && def.behavior === 'colosse') stepBossPhase(state, m, rng)

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

    const action = decideMonsterAction(
      state, m, flow, visible,
      m.squad !== undefined ? squadLag.get(m.squad) : undefined,
    )

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

  // 4a. Profils de style : sur les mêmes événements que la Directrice, après
  // les projectiles pour que les touches à l'arc du tick soient comptées.
  updateProfilesFromEvents(state)

  // 4b. La Directrice. Elle passe en fin de tick, une fois les événements du
  // tick écrits : c'est là-dedans qu'elle lit les dégâts subis, et un appel plus
  // tôt ne verrait qu'une liste vide, donc une intensité éternellement nulle.
  // Elle utilise le champ de vision calculé en début de tick — à la tuile près,
  // personne n'a bougé assez pour que ça change quoi que ce soit.
  runDirector(state, visible, rng)

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
