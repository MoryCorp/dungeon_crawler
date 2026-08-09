/**
 * Tests de l'engine pur — aucun serveur, aucun réseau, aucun navigateur.
 *
 *   npx tsx scripts/engine-test.ts
 */
import {
  ACTOR_RADIUS,
  ATK_GROWTH,
  BLEED_OUT_TICKS,
  FLOOR_HP_GROWTH,
  FOV_RADIUS,
  LEVELS_PER_FLOOR,
  HEART_HEAL_MIN,
  BONE_PER_KILL,
  BONE_ELITE,
  chestPrice,
  TRAP_WARNING_TICKS,
  trapWaveSize,
  slowStrain,
  healCapOf,
  capPrice,
  playerSpeed,
  NEUTRAL_INPUT,
  HEART_HEAL_RATIO,
  MAP_H,
  CARRIED_OF_CAP,
  HEAL_CAP_MIN,
  RESPAWN_OF_CAP,
  REVIVE_OF_CAP,
  healCap,
  FLOW_MAX_DIST,
  HORDE_MAX_DIST,
  MAP_W,
  MONSTERS,
  MONSTER_HALF_ARC,
  PLAYER_BASE_HP,
  PLAYER_SPEED,
  SPRINT_MIN_START,
  SPRINT_MULT,
  SPRINT_REFILL_DELAY,
  DIRECTOR_PATIENCE,
  DIRECTOR_REST,
  HORDE_MIN,
  PURSUE_MAX,
  createDirector,
  pickRecipe,
  profileStats,
  recordReward,
  planWave,
  resolveBehavior,
  splitShares,
  updateDirector,
  RECIPES,
  type BanditArms,
  type Behavior,
  type RecipeName,
  BODY_HEIGHT,
  PROJECTILE_RADIUS,
  hitsBody,
  moveWithCollision,
  separateActors,
  REVIVE_TICKS,
  ROLL_BUFFER,
  ROLL_COOLDOWN,
  TAKE_BUFFER,
  ROLL_COST,
  ROLL_TICKS,
  Rng,
  TARGET_TTK,
  TICK_RATE,
  Tile,
  STAGGER_RECOVER,
  WEAPONS,
  addPlayer,
  biomeOf,
  computeFov,
  createGame,
  descend,
  floorInAct,
  effectiveHp,
  floorScale,
  generateFloor,
  inAttackArc,
  isWalkable,
  movePhysical,
  packBits,
  playerAttackMult,
  playerMaxHp,
  step,
  unpackBits,
  xpForLevel,
  type Actor,
  type GameState,
  type PlayerInput,
} from '@dc/engine'
import { terrainAt } from '../apps/server/src/telemetry.js'

const SWORD = WEAPONS.sword!

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const idle: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false, sprint: false }
const noInputs: Record<string, PlayerInput | null> = {}

/** Vide l'étage de ses monstres pour isoler ce qu'on veut tester. */
function clearMonsters(s: GameState): void {
  for (const a of Object.values(s.actors)) {
    if (a.kind === 'monster') delete s.actors[a.id]
  }
}

/** Pose un monstre déjà aggro à un endroit précis. */
function putMonster(s: GameState, id: string, species: string, x: number, y: number): Actor {
  const def = MONSTERS[species]!
  const m: Actor = {
    id, kind: 'monster', species, name: def.label,
    x, y, kx: 0, ky: 0,
    hp: def.maxHp, maxHp: def.maxHp, atk: def.atk,
    aim: Math.PI, alive: true, swingUntil: 0, readyAt: 0,
    aggroUntil: 999999,
  }
  s.actors[id] = m
  return m
}

console.log('\nTests engine\n')

// --- génération de carte ---------------------------------------------------
{
  const layout = generateFloor(new Rng(12345), 1)
  const floors = layout.tiles.reduce((n, t) => n + (isWalkable(t) ? 1 : 0), 0)
  check('la carte a des salles', layout.rooms.length >= 4, `${layout.rooms.length} salles`)
  check(
    'proportion de sol plausible',
    floors > 300 && floors < MAP_W * MAP_H * 0.6,
    `${floors} cases praticables`,
  )
  check('l\'escalier est posé', layout.tiles[layout.stairs.y * MAP_W + layout.stairs.x] === Tile.Stairs)

  const seen = new Uint8Array(MAP_W * MAP_H)
  const queue = [layout.spawn.y * MAP_W + layout.spawn.x]
  seen[queue[0]!] = 1
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]!
    const x = idx % MAP_W
    const y = (idx / MAP_W) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue
      const ni = ny * MAP_W + nx
      if (seen[ni] || !isWalkable(layout.tiles[ni]!)) continue
      seen[ni] = 1
      queue.push(ni)
    }
  }
  const unreachable = layout.rooms.filter((r) => !seen[(r.y + (r.h >> 1)) * MAP_W + r.x + (r.w >> 1)])
  check('toutes les salles sont accessibles depuis le spawn', unreachable.length === 0, `${unreachable.length} isolées`)
  check('l\'escalier est accessible', Boolean(seen[layout.stairs.y * MAP_W + layout.stairs.x]))
}

// --- géométrie d'attaque ---------------------------------------------------
// C'est le cœur du problème de l'ancien système en grille : un ennemi collé en
// diagonale était intouchable. On vérifie explicitement que ce n'est plus le cas.
{
  const hitDiagonal = inAttackArc(
    10, 10, Math.atan2(1, 1), // on vise le sud-est
    SWORD.halfArc, SWORD.reach,
    10.7, 10.7, ACTOR_RADIUS,
  )
  check('un ennemi en diagonale est touché quand on le vise', hitDiagonal)

  // Et même en visant franchement à l'est, une cible en diagonale au contact
  // reste dans l'arc, parce qu'elle occupe un large secteur de près.
  const hitSloppy = inAttackArc(
    10, 10, 0,
    SWORD.halfArc, SWORD.reach,
    10.6, 10.6, ACTOR_RADIUS,
  )
  check('viser approximativement suffit au contact', hitSloppy)

  const missBehind = inAttackArc(
    10, 10, 0,
    SWORD.halfArc, SWORD.reach,
    8.9, 10, ACTOR_RADIUS,
  )
  check('on ne touche pas dans le dos', !missBehind)

  const missFar = inAttackArc(
    10, 10, 0,
    SWORD.halfArc, SWORD.reach,
    13, 10, ACTOR_RADIUS,
  )
  check('on ne touche pas hors de portée', !missFar)

  // L'arc des monstres est plus étroit, donc esquivable en se décalant.
  const monsterMisses = inAttackArc(
    10, 10, 0,
    MONSTER_HALF_ARC, 1.0,
    10.4, 10.9, ACTOR_RADIUS,
  )
  check('le coup du monstre rate si on se décale sur le côté', !monsterMisses)
}

// --- collisions ------------------------------------------------------------
{
  const tiles = new Uint8Array(MAP_W * MAP_H).fill(Tile.Floor)
  // Un mur vertical en x = 12
  for (let y = 0; y < MAP_H; y++) tiles[y * MAP_W + 12] = Tile.Wall

  const actor = { x: 10, y: 10, kx: 0, ky: 0 }
  for (let i = 0; i < 200; i++) movePhysical(tiles, MAP_W, MAP_H, actor, 1, 0, PLAYER_SPEED)
  check('on ne traverse pas un mur', actor.x < 12, `arrêté à x=${actor.x.toFixed(2)}`)
  check('on s\'arrête au contact du mur', actor.x > 11.5, `x=${actor.x.toFixed(2)}`)

  // Glissement : en poussant en diagonale contre le mur, on doit continuer en Y.
  const slider = { x: 11.6, y: 10, kx: 0, ky: 0 }
  const yBefore = slider.y
  for (let i = 0; i < 30; i++) movePhysical(tiles, MAP_W, MAP_H, slider, 1, 1, PLAYER_SPEED)
  check('on glisse le long des murs', slider.y > yBefore + 1, `y ${yBefore} -> ${slider.y.toFixed(2)}`)

  const speed = { x: 5, y: 5, kx: 0, ky: 0 }
  movePhysical(tiles, MAP_W, MAP_H, speed, 1, 0, PLAYER_SPEED)
  const perStep = speed.x - 5
  check(
    'la vitesse correspond à la constante',
    Math.abs(perStep - PLAYER_SPEED / TICK_RATE) < 1e-6,
    `${perStep.toFixed(4)} tuile/tick`,
  )

  // Un déplacement diagonal ne doit pas être plus rapide qu'un déplacement droit.
  const diag = { x: 5, y: 5, kx: 0, ky: 0 }
  movePhysical(tiles, MAP_W, MAP_H, diag, 1, 1, PLAYER_SPEED)
  const diagDist = Math.hypot(diag.x - 5, diag.y - 5)
  check(
    'pas de bonus de vitesse en diagonale',
    Math.abs(diagDist - PLAYER_SPEED / TICK_RATE) < 1e-6,
    `${diagDist.toFixed(4)} tuile/tick`,
  )
}

// --- une meute ne pousse pas à travers un mur -------------------------------
// Vu en jeu : quatre monstres acculant le héros contre la paroi finissaient par
// le faire passer au travers, poussée après poussée, et il restait coincé.
{
  const s = createGame(3131)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_squeeze', 'Coincé')
  // On le colle contre un mur, puis on l'entoure de monstres qui poussent.
  let wallX = -1
  for (let x = Math.floor(hero.x); x > 0; x--) {
    if (!isWalkable(s.tiles[Math.floor(hero.y) * MAP_W + x]!)) {
      wallX = x
      break
    }
  }
  hero.x = wallX + 1.4
  for (let i = 0; i < 5; i++) {
    putMonster(s, `m_push${i}`, 'bat', hero.x + 0.4 + i * 0.05, hero.y - 0.2 + i * 0.1)
  }

  for (let i = 0; i < TICK_RATE * 4; i++) step(s, noInputs)
  const onFloor = isWalkable(s.tiles[Math.floor(hero.y) * MAP_W + Math.floor(hero.x)]!)
  check('une meute ne pousse pas le héros dans un mur', onFloor,
    `(${hero.x.toFixed(2)},${hero.y.toFixed(2)})`)
}

// --- le recul ne verrouille plus un monstre ---------------------------------
// C'était LE défaut du jeu : l'épée repoussait juste assez vite pour qu'un
// monstre au corps à corps ne finisse jamais sa préparation. On pouvait
// traverser le donjon en avançant tout droit et en bourrinant le clic.
{
  const s = createGame(4141)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_spam', 'Bourrin')
  hero.invulnUntil = 0
  const hpBefore = hero.hp
  const target = putMonster(s, 'm_lock', 'skeleton', hero.x + 1.2, hero.y)
  target.hp = 9999 // il ne doit pas mourir : on teste le contrôle, pas les dégâts

  const spam: PlayerInput = { mx: 0, my: 0, aim: 0, attack: true, sprint: false }
  for (let i = 0; i < TICK_RATE * 8; i++) step(s, { p_spam: spam })

  check(
    'bourriner l\'attaque ne suffit plus à tenir un monstre à distance',
    hero.hp < hpBefore,
    `${hpBefore} -> ${hero.hp} PV`,
  )

  // Et le recul reste franc au premier coup : c'est ce qui rend une hache
  // satisfaisante. On vérifie juste que la dégressivité n'a pas tout écrasé.
  const s2 = createGame(4141)
  clearMonsters(s2)
  const hero2 = addPlayer(s2, 'p_hit', 'Cogneur')
  hero2.weapon = 'axe'
  const victim = putMonster(s2, 'm_push', 'skeleton', hero2.x + 1.0, hero2.y)
  victim.hp = 9999
  const x0 = victim.x
  step(s2, { p_hit: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  const firstPush = Math.hypot(victim.kx, victim.ky)
  check('le premier coup projette franchement', firstPush > 3, `recul ${firstPush.toFixed(1)}`)

  // Le deuxième coup enchaîné doit pousser nettement moins.
  hero2.readyAt = s2.tick
  const before = Math.hypot(victim.kx, victim.ky)
  step(s2, { p_hit: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  const secondPush = Math.hypot(victim.kx, victim.ky) - before
  check(
    'les coups enchaînés poussent de moins en moins',
    secondPush < firstPush / 1.5,
    `${firstPush.toFixed(1)} puis ${Math.max(0, secondPush).toFixed(1)}`,
  )
  void x0
}

// --- frapper engage ---------------------------------------------------------
// Deux fois la même course depuis la même case, une fois en frappant. C'est ce
// coût qui empêche « avancer en cliquant » d'être gratuit, et qui donne une
// identité à chaque arme : la hache cloue sur place, la dague à peine.
{
  const travel = (attack: boolean, weapon: string): number => {
    const s = createGame(4242)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_go', 'Coureur')
    hero.weapon = weapon
    // Cap dégagé : on veut mesurer un ralentissement, pas une collision.
    const dir = isWalkable(s.tiles[Math.floor(hero.y) * MAP_W + Math.floor(hero.x) + 1]!) ? 1 : -1
    const start = hero.x
    const input: PlayerInput = { mx: dir, my: 0, aim: dir > 0 ? 0 : Math.PI, attack, sprint: false }
    for (let i = 0; i < TICK_RATE; i++) step(s, { p_go: input })
    return Math.abs(hero.x - start)
  }

  const free = travel(false, 'sword')
  const sword = travel(true, 'sword')
  const axe = travel(true, 'axe')
  const dagger = travel(true, 'dagger')

  check('frapper en avançant coûte de la vitesse', sword < free * 0.9,
    `${free.toFixed(2)} libre vs ${sword.toFixed(2)} en frappant`)
  check('la hache engage plus que l\'épée', axe < sword, `hache ${axe.toFixed(2)} < épée ${sword.toFixed(2)}`)
  check('la dague n\'engage presque pas', dagger > sword, `dague ${dagger.toFixed(2)}`)
}

// --- la roulade --------------------------------------------------------------
// Le deuxième verbe défensif : courte, chère, invulnérable au départ. On
// vérifie le contrat entier — distance, i-frames, coût, seuil, temps mort,
// interdits (lame sortie, mur) et la gratuité sous fiole de souffle.
{
  const fresh = (): { s: GameState; hero: Actor; dir: number } => {
    const s = createGame(4242)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_r', 'Rouleur')
    const dir = isWalkable(s.tiles[Math.floor(hero.y) * MAP_W + Math.floor(hero.x) + 1]!) ? 1 : -1
    return { s, hero, dir }
  }
  const rollInput = (dir: number): PlayerInput =>
    ({ mx: dir, my: 0, aim: dir > 0 ? 0 : Math.PI, attack: false, sprint: false, roll: true })

  {
    const { s, hero, dir } = fresh()
    const start = hero.x
    step(s, { p_r: rollInput(dir) })
    check('la roulade s\'engage et donne des i-frames',
      hero.rollUntil !== undefined && (hero.invulnUntil ?? 0) > s.tick,
      `rollUntil=${hero.rollUntil} invuln=${hero.invulnUntil} tick=${s.tick}`)
    check('la roulade coûte sa part de jauge',
      Math.abs((hero.stamina ?? 1) - (1 - ROLL_COST)) < 0.01, `jauge ${hero.stamina?.toFixed(2)}`)
    // roll:true traîne dans l'entrée comme un paquet réseau rejoué : le temps
    // mort doit empêcher la roulade de repartir en boucle.
    for (let i = 0; i < ROLL_TICKS; i++) step(s, { p_r: rollInput(dir) })
    const dist = Math.abs(hero.x - start)
    check('elle couvre ~2,3 tuiles puis s\'arrête', dist > 1.8 && dist < 2.8, `${dist.toFixed(2)} tuiles`)
    check('pas de seconde roulade pendant le temps mort',
      hero.rollUntil === undefined && Math.abs((hero.stamina ?? 1) - (1 - ROLL_COST)) < 0.03,
      `jauge ${hero.stamina?.toFixed(2)}`)
    for (let i = 0; i < ROLL_COOLDOWN + 2; i++) step(s, { p_r: idle })
    step(s, { p_r: rollInput(dir) })
    check('le temps mort passé, on peut re-rouler', hero.rollUntil !== undefined)
  }

  {
    const { s, hero, dir } = fresh()
    hero.stamina = 0.3
    step(s, { p_r: rollInput(dir) })
    check('sous le seuil de jauge, pas de roulade', hero.rollUntil === undefined,
      `jauge ${hero.stamina?.toFixed(2)}`)
  }

  {
    // La roulade coupe la récupération du coup : le coup a déjà porté, seule
    // l'animation saute. C'est ce qui rend la commande fiable clic enfoncé.
    const { s, hero, dir } = fresh()
    hero.swingUntil = s.tick + 10
    step(s, { p_r: rollInput(dir) })
    check('la roulade coupe la récupération du coup',
      hero.rollUntil !== undefined && hero.swingUntil <= s.tick)
  }

  {
    // Tampon d'entrée : une impulsion tombée pendant le temps mort part dès
    // que le temps mort est écoulé, au lieu d'être perdue.
    const { s, hero, dir } = fresh()
    step(s, { p_r: rollInput(dir) })
    const readyAt = (hero.rolledAt ?? 0) + ROLL_TICKS + ROLL_COOLDOWN
    while (s.tick < readyAt - 3) step(s, { p_r: idle })
    // Une seule pression, trois ticks trop tôt, puis plus rien.
    step(s, { p_r: rollInput(dir) })
    const tooEarly = hero.rollUntil === undefined
    for (let i = 0; i < 5; i++) step(s, { p_r: idle })
    check('une impulsion un peu trop précoce est mémorisée puis jouée',
      tooEarly && hero.rollUntil !== undefined)

    // Mais elle ne se garde pas indéfiniment : appuyer une seconde trop tôt
    // ne doit pas déclencher une roulade fantôme bien plus tard.
    const b = fresh()
    b.hero.stamina = 0.1
    step(b.s, { p_r: rollInput(b.dir) })
    for (let i = 0; i < ROLL_BUFFER * 3; i++) step(b.s, { p_r: idle })
    b.hero.stamina = 1
    step(b.s, { p_r: idle })
    check('un tampon expiré ne déclenche rien', b.hero.rollUntil === undefined)
  }

  {
    const { s, hero, dir } = fresh()
    hero.stamina = 0.2
    hero.freshUntil = s.tick + 300
    step(s, { p_r: rollInput(dir) })
    check('sous fiole de souffle, la roulade est gratuite',
      hero.rollUntil !== undefined && Math.abs((hero.stamina ?? 1) - 0.2) < 0.01,
      `jauge ${hero.stamina?.toFixed(2)}`)
  }

  {
    // Face à un mur : la roulade se coupe net au lieu de gratter la paroi.
    const { s, hero } = fresh()
    let placed = false
    for (let y = 2; y < MAP_H - 2 && !placed; y++) {
      for (let x = 2; x < MAP_W - 2 && !placed; x++) {
        if (isWalkable(s.tiles[y * MAP_W + x]!) && !isWalkable(s.tiles[y * MAP_W + x + 1]!)) {
          hero.x = x + 0.5
          hero.y = y + 0.5
          placed = true
        }
      }
    }
    const start = hero.x
    step(s, { p_r: rollInput(1) })
    step(s, { p_r: idle })
    check('un mur coupe la roulade',
      placed && hero.rollUntil === undefined && Math.abs(hero.x - start) < 0.4,
      `parcouru ${Math.abs(hero.x - start).toFixed(2)}`)
  }
}

// --- ramassage explicite des armes --------------------------------------------
// Marcher sur une arme ne la ramasse plus : repasser dans un couloir
// rééquipait celle qu'on venait d'abandonner. Tout le reste se prend toujours
// en marchant dessus — un soin ne pose aucune question, une arme si.
{
  const s = createGame(4242)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_t', 'Ramasseur')
  hero.weapon = 'sword'
  s.items.push({ id: 'it_axe', kind: 'weapon', x: hero.x, y: hero.y, weapon: 'axe' })

  for (let i = 0; i < 10; i++) step(s, { p_t: idle })
  check('marcher sur une arme ne la ramasse pas', hero.weapon === 'sword')

  step(s, { p_t: { ...idle, take: true } })
  check('la demande explicite la ramasse', hero.weapon === 'axe')

  // L'ancienne arme retombe au sol, verrouillée le temps qu'on s'éloigne :
  // une seule pression ne doit pas faire l'aller-retour.
  step(s, { p_t: { ...idle, take: true } })
  check('une pression ne rééquipe pas l\'ancienne dans la foulée', hero.weapon === 'axe')

  const soin = createGame(4242)
  clearMonsters(soin)
  const other = addPlayer(soin, 'p_s', 'Passant')
  other.hp = 1
  soin.items.push({ id: 'it_heart', kind: 'heart', x: other.x, y: other.y })
  step(soin, { p_s: idle })
  check('le reste se ramasse toujours en marchant dessus', other.hp > 1, `${other.hp} PV`)
}

// --- décor de repérage --------------------------------------------------------
// Purement visuel : il doit être posé sur du sol, ne jamais occuper le spawn
// ni l'escalier, donner une signature par salle, et surtout ne rien changer au
// jeu — son tirage est séparé de celui de la partie.
{
  const rng1 = new Rng(9001)
  const a = generateFloor(rng1, 4)
  const b = generateFloor(new Rng(9001), 4)

  check('chaque étage est décoré', a.decor.length > 0, `${a.decor.length} éléments`)
  check(
    'le décor est toujours sur du sol',
    a.decor.every((d) => a.tiles[d.y * MAP_W + d.x] === Tile.Floor),
  )
  check(
    'ni sur le spawn ni sur l\'escalier',
    a.decor.every(
      (d) =>
        !(d.x === a.spawn.x && d.y === a.spawn.y) &&
        !(d.x === a.stairs.x && d.y === a.stairs.y),
    ),
  )
  check(
    'même graine = même décor',
    JSON.stringify(a.decor) === JSON.stringify(b.decor),
  )
  // Une salle = un motif dominant : c'est la répétition qui fait le repère.
  const room = a.rooms.find(
    (r) => a.decor.filter((d) => d.x >= r.x && d.x < r.x + r.w && d.y >= r.y && d.y < r.y + r.h).length > 1,
  )
  const inRoom = room
    ? a.decor.filter((d) => d.x >= room.x && d.x < room.x + room.w && d.y >= room.y && d.y < room.y + room.h)
    : []
  check(
    'une salle porte une signature, pas un bric-à-brac',
    inRoom.length > 1 && new Set(inRoom.map((d) => d.kind)).size === 1,
    inRoom.map((d) => d.kind).join(','),
  )

  // Le point crucial : décorer ne doit pas décaler le flux aléatoire de la
  // partie. On compare la géométrie d'un étage aux monstres qu'il peuple.
  const peuplement = (s: GameState): string =>
    Object.values(s.actors)
      .map((m) => `${m.species}@${m.x.toFixed(2)},${m.y.toFixed(2)}`)
      .sort()
      .join('|')
  const g1 = createGame(9001, 4)
  const g2 = createGame(9001, 4)
  check(
    'le décor ne déplace rien dans la partie',
    peuplement(g1) === peuplement(g2) && g1.decor.length > 0 && Object.keys(g1.actors).length > 0,
  )
}

// --- angles de couloir : le nudge --------------------------------------------
// Mal aligné de quelques pixels sur l'embouchure d'un couloir, on glissait
// contre le coin et on restait planté. Désormais, un accrochage léger fait
// glisser latéralement dans l'ouverture ; un vrai mur bloque toujours.
{
  const W = 12
  const tiles = new Uint8Array(W * W).fill(Tile.Wall)
  for (let x = 1; x < 11; x++) tiles[2 * W + x] = Tile.Floor
  for (let y = 2; y < 11; y++) tiles[y * W + 4] = Tile.Floor

  const walk = (startX: number): number => {
    let p = { x: startX, y: 2.5 }
    for (let i = 0; i < 40; i++) p = moveWithCollision(tiles, W, W, p.x, p.y, 0, 0.14, ACTOR_RADIUS)
    return p.y
  }
  check('un léger désalignement glisse dans le couloir', walk(4.2) > 5, `y=${walk(4.2).toFixed(2)}`)
  check('un vrai mur bloque toujours', walk(6.5) < 3, `y=${walk(6.5).toFixed(2)}`)
}

// --- hitbox verticale --------------------------------------------------------
// Le point (x, y) est le cercle au sol ; le sprite se dresse au-dessus. Les
// projectiles testent la capsule entière : une flèche dans le torse touche.
{
  const r = ACTOR_RADIUS + PROJECTILE_RADIUS
  check('la capsule couvre le torse', hitsBody(5, 5 - BODY_HEIGHT, 5, 5, r, BODY_HEIGHT))
  check('l\'ancien cercle seul l\'aurait raté', BODY_HEIGHT > r)
  check('au-dessus de la tête, on rate encore', !hitsBody(5, 5 - 1.3, 5, 5, r, BODY_HEIGHT))

  const s = createGame(4242)
  clearMonsters(s)
  addPlayer(s, 'p_h', 'Archer')
  // Une case au sol dont la voisine du haut l'est aussi : le tir « au torse »
  // vole dans la tuile au-dessus des pieds, elle doit être traversable.
  let cx = 0
  let cy = 0
  outer: for (let y = 5; y < MAP_H - 5; y++) {
    for (let x = 5; x < MAP_W - 5; x++) {
      if (isWalkable(s.tiles[y * MAP_W + x]!) && isWalkable(s.tiles[(y - 1) * MAP_W + x]!)) {
        cx = x + 0.5
        cy = y + 0.5
        break outer
      }
    }
  }
  const m = putMonster(s, 'm_cible', 'skeleton', cx, cy)
  s.projectiles.push({
    id: 'pr_test', ownerId: 'p_h', ownerSpecies: 'hero', hostileToPlayers: false,
    x: m.x, y: m.y - 0.5, vx: 0.5, vy: 0, damage: 3, knockback: 0, ttl: 10, color: 0xffffff,
  })
  step(s, { p_h: idle })
  check('en jeu, le tir au torse blesse', m.hp < m.maxHp, `${m.hp}/${m.maxHp}`)
}

// --- bodyblock des couloirs --------------------------------------------------
// Deux monstres se tolèrent plus près que le contact plein : le suiveur se
// glisse derrière le meneur au lieu de le coincer contre l'embouchure.
{
  const W = 12
  const open = new Uint8Array(W * W).fill(Tile.Floor)
  const settle = (kindA: string, kindB: string): number => {
    const a = { x: 5, y: 5, alive: true, kind: kindA }
    const b = { x: 5.1, y: 5, alive: true, kind: kindB }
    for (let i = 0; i < 30; i++) separateActors(open, W, W, [a, b], ACTOR_RADIUS)
    return Math.hypot(b.x - a.x, b.y - a.y)
  }
  const mm = settle('monster', 'monster')
  const pm = settle('player', 'monster')
  check('deux monstres se chevauchent un peu', mm < 0.5, `${mm.toFixed(2)} tuile`)
  check('le joueur garde ses distances pleines', pm > 0.6, `${pm.toFixed(2)} tuile`)
}

// --- le renvoi de projectile -------------------------------------------------
// Un coup de mêlée qui balaie un projectile hostile le renvoie vers son tireur,
// dégâts d'origine. La réponse au mage, sans toucher à ses chiffres.
{
  const s = createGame(4242)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_p', 'Parieur')
  // Le mage est posé plein est, hors de portée de l'arc de mêlée.
  const mage = putMonster(s, 'm_mage', 'skeleton_mage', hero.x + 6, hero.y)
  s.projectiles.push({
    id: 'pr_bolt', ownerId: 'm_mage', ownerSpecies: 'skeleton_mage', hostileToPlayers: true,
    x: hero.x + 0.8, y: hero.y, vx: -6, vy: 0, damage: 5, knockback: 2, ttl: 60, color: 0x9b5cf0,
  })
  step(s, { p_p: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  const p = s.projectiles.find((pr) => pr.id === 'pr_bolt')
  const parried = s.events.some((ev) => ev.t === 'parry')
  check('le coup d\'épée renvoie le projectile', parried && p !== undefined && !p.hostileToPlayers)
  check('il repart vers son tireur', p !== undefined && p.vx > 0, `vx=${p?.vx.toFixed(1)}`)
  let hits = 0
  for (let i = 0; i < 40 && mage.hp === mage.maxHp; i++) {
    step(s, { p_p: idle })
    hits = mage.maxHp - mage.hp
  }
  check('et il blesse le mage au retour', hits > 0, `${hits} dégâts`)
}

// --- le cancel de ruée -------------------------------------------------------
// Frapper un chargeur en pleine ruée la coupe net : même sanction que le mur,
// il s'arrête vulnérable. Vaut aussi pour le boss — c'est un coup au timing.
{
  const s = createGame(4242)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_c', 'Contreur')
  const dir = isWalkable(s.tiles[Math.floor(hero.y) * MAP_W + Math.floor(hero.x) + 1]!) ? 1 : -1
  const orc = putMonster(s, 'm_rush', 'orc_warrior', hero.x + dir, hero.y)
  orc.dashUntil = s.tick + 20
  orc.dashVx = -dir
  orc.dashVy = 0
  step(s, { p_c: { mx: 0, my: 0, aim: dir > 0 ? 0 : Math.PI, attack: true, sprint: false } })
  check('un coup au timing coupe la ruée',
    orc.dashUntil === undefined && s.events.some((ev) => ev.t === 'dashbreak'))
  check('le chargeur reste vulnérable un instant', orc.readyAt > s.tick, `readyAt=${orc.readyAt} tick=${s.tick}`)
}

// --- la difficulté monte avec l'étage ---------------------------------------
{
  const shallow = createGame(5252, 1)
  const deep = createGame(5252, 10)
  const pick = (s: GameState, species: string) =>
    Object.values(s.actors).find((a) => a.species === species && !a.elite && !a.boss)

  const a = pick(shallow, 'skeleton')
  const b = pick(deep, 'skeleton')
  check('un squelette profond a plus de PV', !a || !b || b.maxHp > a.maxHp * 1.5,
    `${a?.maxHp} -> ${b?.maxHp}`)
  check('un squelette profond frappe plus fort', !a || !b || b.atk > a.atk, `${a?.atk} -> ${b?.atk}`)
  check(
    'un étage profond est plus peuplé',
    Object.keys(deep.actors).length > Object.keys(shallow.actors).length,
    `${Object.keys(shallow.actors).length} -> ${Object.keys(deep.actors).length}`,
  )
}

// --- un joueur à terre finit par mourir même sous les coups ------------------
// Trouvé par la télémétrie : 231 mises à terre sur un seul étage. Les appelants
// testent `hp <= 0` après `damage()`, or un joueur à terre est à 0 PV — chaque
// coup le remettait à terre et relançait son compte à rebours de saignement.
{
  const s = createGame(6161)
  clearMonsters(s)
  const victim = addPlayer(s, 'p_bleed', 'Saigneur')
  victim.hp = 1
  victim.invulnUntil = 0
  putMonster(s, 'm_camp', 'skeleton', victim.x + 0.7, victim.y)

  let downs = 0
  let died = false
  for (let i = 0; i < BLEED_OUT_TICKS + TICK_RATE * 5 && !died; i++) {
    step(s, noInputs)
    downs += s.events.filter((e) => e.t === 'downed').length
    died = !s.actors['p_bleed']!.alive
  }
  check('on n\'est mis à terre qu\'une fois', downs === 1, `${downs} mise(s) à terre`)
  check('un monstre qui campe le corps n\'empêche pas de saigner', died)
}

// --- le wipe : plus personne debout = partie finie ---------------------------
// En solo, une mise à terre est une agonie sans issue (aucun auto-relevage) :
// mort sèche immédiate et événement `wipe`, sur lequel le serveur relance une
// descente neuve dans la même room. En équipe, tant qu'un coéquipier tient
// debout, la mise à terre classique garde tout son sens.
{
  const solo = createGame(7272)
  clearMonsters(solo)
  const hero = addPlayer(solo, 'p_solo', 'Seul')
  hero.hp = 1
  hero.invulnUntil = 0
  putMonster(solo, 'm_solo', 'skeleton', hero.x + 0.7, hero.y)
  let wiped = false
  let downedThenDead = false
  for (let i = 0; i < TICK_RATE * 5 && !wiped; i++) {
    step(solo, noInputs)
    if (solo.events.some((e) => e.t === 'wipe')) {
      wiped = true
      downedThenDead =
        solo.events.some((e) => e.t === 'downed') && solo.events.some((e) => e.t === 'death' && e.kind === 'player')
    }
  }
  check('seul, tomber c\'est mourir : le wipe part tout de suite', wiped)
  check('le wipe emporte la mise à terre et la mort (télémétrie)', downedThenDead)
  check('le héros est bien mort, pas à terre', !solo.actors['p_solo']!.alive)

  const duo = createGame(7373)
  clearMonsters(duo)
  const a = addPlayer(duo, 'p_a', 'Premier')
  const b = addPlayer(duo, 'p_b', 'Second')
  b.x = a.x + 6
  b.y = a.y
  a.hp = 1
  a.invulnUntil = 0
  putMonster(duo, 'm_duo', 'skeleton', a.x + 0.7, a.y)
  let aDown = false
  let earlyWipe = false
  for (let i = 0; i < TICK_RATE * 3 && !aDown; i++) {
    step(duo, noInputs)
    if (duo.events.some((e) => e.t === 'wipe')) earlyWipe = true
    if (duo.actors['p_a']!.downed) aDown = true
  }
  check('en duo, tomber reste une mise à terre', aDown && duo.actors['p_a']!.alive)
  check('pas de wipe tant qu\'un coéquipier tient debout', !earlyWipe)
}

// --- déterminisme ----------------------------------------------------------
{
  const a = createGame(999)
  const b = createGame(999)
  for (let i = 0; i < 300; i++) {
    step(a, noInputs)
    step(b, noInputs)
  }
  const fingerprint = (s: GameState) =>
    JSON.stringify(
      Object.values(s.actors)
        .map((m) => `${m.id}:${m.x.toFixed(4)},${m.y.toFixed(4)},${m.hp}`)
        .sort(),
    )
  check('même graine = même partie après 300 ticks', fingerprint(a) === fingerprint(b))
  check('les monstres sont peuplés', Object.keys(a.actors).length > 0, `${Object.keys(a.actors).length} acteurs`)
}

// --- le donjon vit sans joueur ---------------------------------------------
{
  const s = createGame(4242)
  const before = Object.values(s.actors).map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join('|')
  for (let i = 0; i < 120; i++) step(s, noInputs)
  const after = Object.values(s.actors).map((m) => `${m.x.toFixed(2)},${m.y.toFixed(2)}`).join('|')
  check('les monstres bougent même sans joueur connecté', before !== after)
}

// --- champ de vision -------------------------------------------------------
{
  const s = createGame(777)
  const vis = new Uint8Array(MAP_W * MAP_H)
  computeFov(s.tiles, MAP_W, MAP_H, s.spawn.x, s.spawn.y, FOV_RADIUS, vis)
  const count = vis.reduce((a, b) => a + b, 0)
  check('le champ de vision couvre une zone crédible', count > 10 && count <= Math.PI * FOV_RADIUS ** 2, `${count} cases`)
  check('on se voit soi-même', vis[s.spawn.y * MAP_W + s.spawn.x] === 1)
  check('rien n\'est visible au-delà du rayon', vis[(s.spawn.y + FOV_RADIUS + 3) * MAP_W + s.spawn.x] !== 1)
}

// --- bitset réseau ---------------------------------------------------------
{
  const src = new Uint8Array(MAP_W * MAP_H)
  for (let i = 0; i < src.length; i += 3) src[i] = 1
  const round = unpackBits(packBits(src), src.length)
  check('packBits/unpackBits est réversible', round.every((v, i) => v === src[i]))
  check('le bitset compresse bien', packBits(src).length === src.length / 8, `${packBits(src).length} octets pour ${src.length} cases`)
}

// --- combat en jeu ---------------------------------------------------------
{
  const s = createGame(31337)
  const hero = addPlayer(s, 'p_test', 'Testeur')

  // On place un monstre en diagonale, exactement la situation qui était
  // injouable avant.
  const monster = Object.values(s.actors).find((a) => a.kind === 'monster')!
  monster.x = hero.x + 0.7
  monster.y = hero.y + 0.7
  monster.hp = monster.maxHp
  const hpBefore = monster.hp

  const attackDiag: PlayerInput = { mx: 0, my: 0, aim: Math.atan2(0.7, 0.7), attack: true, sprint: false }
  step(s, { p_test: attackDiag })
  const target = s.actors[monster.id]
  check(
    'frapper un monstre en diagonale lui inflige des dégâts',
    !target || target.hp < hpBefore,
    target ? `${hpBefore} -> ${target.hp}` : 'tué',
  )
  check('le recul éloigne la cible', !target || Math.hypot(target.kx, target.ky) > 0, target ? `k=${Math.hypot(target.kx, target.ky).toFixed(1)}` : 'tué')
}

// --- esquive : le coup préparé rate si on sort de l'arc ---------------------
{
  const s = createGame(5150)
  const hero = addPlayer(s, 'p_dodge', 'Esquiveur')
  for (const a of Object.values(s.actors)) {
    if (a.kind === 'monster') delete s.actors[a.id]
  }

  const def = MONSTERS.skeleton_warrior!
  s.actors['m_test'] = {
    id: 'm_test', kind: 'monster', species: 'skeleton_warrior', name: def.label,
    x: hero.x + 0.8, y: hero.y, kx: 0, ky: 0,
    hp: def.maxHp, maxHp: def.maxHp, atk: def.atk,
    aim: Math.PI, alive: true, swingUntil: 0, readyAt: 0,
    aggroUntil: 999999,
  }
  hero.invulnUntil = 0

  // On laisse la préparation démarrer, puis on s'écarte perpendiculairement.
  const flee: PlayerInput = { mx: 0, my: -1, aim: 0, attack: false, sprint: false }
  const hpBefore = hero.hp
  for (let i = 0; i < def.windup + 6; i++) step(s, { p_dodge: flee })
  check(
    'on esquive un coup télégraphié en se déplaçant',
    s.actors['p_dodge']!.hp === hpBefore,
    `${hpBefore} -> ${s.actors['p_dodge']!.hp}`,
  )

  // À l'inverse, rester planté doit coûter des points de vie.
  const s2 = createGame(5150)
  const hero2 = addPlayer(s2, 'p_static', 'Statue')
  for (const a of Object.values(s2.actors)) {
    if (a.kind === 'monster') delete s2.actors[a.id]
  }
  s2.actors['m_test'] = {
    id: 'm_test', kind: 'monster', species: 'skeleton_warrior', name: def.label,
    x: hero2.x + 0.8, y: hero2.y, kx: 0, ky: 0,
    hp: def.maxHp, maxHp: def.maxHp, atk: def.atk,
    aim: 0, alive: true, swingUntil: 0, readyAt: 0,
    aggroUntil: 999999,
  }
  hero2.invulnUntil = 0
  const hp2Before = hero2.hp
  for (let i = 0; i < def.windup + 10; i++) step(s2, { p_static: idle })
  check(
    'rester immobile devant un coup préparé fait mal',
    s2.actors['p_static']!.hp < hp2Before,
    `${hp2Before} -> ${s2.actors['p_static']!.hp}`,
  )
}

// --- mise à terre, saignement, réapparition --------------------------------
// Avec un coéquipier debout : depuis le wipe, un héros seul meurt sèchement
// au lieu de tomber — la mise à terre n'existe que s'il reste quelqu'un pour
// relever. Le coéquipier est parqué loin du corps pour ne pas le relever.
{
  const s = createGame(2024)
  const hero = addPlayer(s, 'p_dead', 'Mort')
  const mate = addPlayer(s, 'p_mate', 'Témoin')
  mate.x = hero.x + 20
  mate.y = hero.y
  hero.hp = 1
  hero.invulnUntil = 0
  const monster = Object.values(s.actors).find((a) => a.kind === 'monster')!
  monster.x = hero.x + 0.5
  monster.y = hero.y
  monster.aggroUntil = 999999

  let down = false
  for (let i = 0; i < TICK_RATE * 10 && !down; i++) {
    step(s, noInputs)
    down = s.actors['p_dead']!.downed === true
  }
  check('un héros à 1 PV tombe à terre au lieu de mourir', down)
  check('il est encore en vie tant qu\'il saigne', s.actors['p_dead']!.alive)

  clearMonsters(s)
  // Personne ne vient le relever : il finit par mourir pour de bon.
  for (let i = 0; i < BLEED_OUT_TICKS + 5; i++) step(s, noInputs)
  check('sans relevage, il finit par mourir', !s.actors['p_dead']!.alive)

  for (let i = 0; i < TICK_RATE * 12; i++) step(s, noInputs)
  check('le héros réapparaît tout seul', s.actors['p_dead']!.alive)
  check('il est invulnérable un instant après le respawn', (s.actors['p_dead']!.invulnUntil ?? 0) > 0)
}

// --- relève par un coéquipier ----------------------------------------------
// C'est le cœur de la coopération : rester au sol à côté de son pote a un coût
// (on ne se défend pas) et un effet (il se relève).
{
  const s = createGame(8080)
  clearMonsters(s)
  const victim = addPlayer(s, 'p_down', 'Tombé')
  const helper = addPlayer(s, 'p_help', 'Sauveur')
  victim.hp = 1
  victim.invulnUntil = 0

  putMonster(s, 'm_killer', 'skeleton_warrior', victim.x + 0.6, victim.y)
  for (let i = 0; i < TICK_RATE * 8 && !victim.downed; i++) step(s, noInputs)
  check('la victime est à terre', victim.downed === true)
  clearMonsters(s)

  // Le sauveur est loin : rien ne se passe.
  helper.x = victim.x + 6
  helper.y = victim.y
  for (let i = 0; i < REVIVE_TICKS; i++) step(s, noInputs)
  check('on ne relève pas de loin', (victim.reviveProgress ?? 0) === 0)

  // Il se colle : la relève avance et aboutit.
  helper.x = victim.x + 0.5
  helper.y = victim.y
  for (let i = 0; i < REVIVE_TICKS + 4; i++) step(s, noInputs)
  check('un coéquipier collé relève la victime', victim.downed === false)
  check('elle repart avec une partie de ses PV', victim.hp > 0 && victim.hp < victim.maxHp, `${victim.hp}/${victim.maxHp}`)
}

// --- armes : la portée change vraiment le jeu -------------------------------
{
  const s = createGame(1717)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_reach', 'Lancier')
  const target = putMonster(s, 'm_far', 'skeleton', hero.x + 2.0, hero.y)
  target.hp = 999

  hero.weapon = 'dagger'
  step(s, { p_reach: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  check('la dague ne touche pas à 2 tuiles', target.hp === 999)

  hero.weapon = 'spear'
  hero.readyAt = s.tick
  step(s, { p_reach: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  check('la lance touche à 2 tuiles', target.hp < 999, `hp=${target.hp}`)
}

// --- arc : le coup part en projectile ---------------------------------------
{
  const s = createGame(1818)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_bow', 'Archer')
  hero.weapon = 'bow'
  const target = putMonster(s, 'm_shot', 'skeleton', hero.x + 4, hero.y)
  target.hp = 999

  step(s, { p_bow: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  check('tirer crée un projectile', s.projectiles.length === 1)

  for (let i = 0; i < TICK_RATE && target.hp === 999; i++) step(s, noInputs)
  check('la flèche atteint une cible à 4 tuiles', target.hp < 999, `hp=${target.hp}`)
  check('le projectile disparaît à l\'impact', s.projectiles.length === 0)
}

// --- kamikaze : explosion de zone -------------------------------------------
{
  const s = createGame(1919)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_boom', 'Cible')
  hero.invulnUntil = 0
  const hpBefore = hero.hp
  putMonster(s, 'm_bomb', 'orc_bomber', hero.x + 1.0, hero.y)

  let blasted = false
  for (let i = 0; i < TICK_RATE * 4 && !blasted; i++) {
    step(s, noInputs)
    blasted = s.events.some((e) => e.t === 'blast')
  }
  check('le kamikaze explose', blasted)
  check('l\'explosion blesse le joueur', hero.hp < hpBefore, `${hpBefore} -> ${hero.hp}`)
  check('le kamikaze meurt avec son explosion', s.actors['m_bomb'] === undefined)
}

// --- chargeur : la ruée blesse au contact -----------------------------------
{
  const s = createGame(2020)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_charge', 'Statique')
  hero.invulnUntil = 0
  const hpBefore = hero.hp
  // On le pose assez loin pour qu'il ait la place de s'élancer.
  putMonster(s, 'm_dash', 'skeleton_rogue', hero.x + 3.5, hero.y)

  let dashed = false
  for (let i = 0; i < TICK_RATE * 6 && hero.hp === hpBefore; i++) {
    step(s, noInputs)
    if (s.actors['m_dash']?.dashUntil !== undefined) dashed = true
  }
  check('le chargeur s\'élance', dashed)
  check('la ruée touche une cible immobile', hero.hp < hpBefore, `${hpBefore} -> ${hero.hp}`)
}

// --- loot, XP et niveaux ----------------------------------------------------
{
  const s = createGame(2121)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_loot', 'Pilleur')
  hero.weapon = 'spear'
  // Assez loin pour que le butin ne soit pas aspiré dans le même tick.
  const victim = putMonster(s, 'm_prey', 'skeleton', hero.x + 2.2, hero.y)
  victim.hp = 1

  const itemsBefore = s.items.length
  step(s, { p_loot: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  check('tuer un monstre laisse du butin', s.items.length > itemsBefore, `${s.items.length} objets`)
  check('l\'XP ne tombe qu\'avec le butin ramassé', (hero.xp ?? 0) === 0)

  for (let i = 0; i < TICK_RATE * 2; i++) step(s, noInputs)
  check('l\'orbe rejoint le joueur et donne son XP', (hero.xp ?? 0) > 0, `${hero.xp} xp`)

  // Un tas d'XP juste devant doit finir dans la poche, aimanté.
  s.items.push({ id: 'i_xp', kind: 'xp', x: hero.x + 2, y: hero.y, amount: xpForLevel(2) })
  for (let i = 0; i < TICK_RATE * 2; i++) step(s, noInputs)
  check('les orbes d\'XP sont aimantées et ramassées', !s.items.some((i) => i.id === 'i_xp'))
  check('assez d\'XP fait monter de niveau', (hero.level ?? 1) >= 2, `niveau ${hero.level}`)
  check('le niveau augmente les PV max', hero.maxHp > PLAYER_BASE_HP, `${hero.maxHp} PV max`)

  // Un cœur ne se ramasse que si on en a besoin : sinon il reste au sol.
  hero.hp = hero.maxHp
  s.items.push({ id: 'i_full', kind: 'heart', x: hero.x, y: hero.y })
  step(s, noInputs)
  check('un cœur inutile reste au sol', s.items.some((i) => i.id === 'i_full'))

  hero.hp = 5
  for (let i = 0; i < 3; i++) step(s, noInputs)
  const heal = Math.max(HEART_HEAL_MIN, Math.round(hero.maxHp * HEART_HEAL_RATIO))
  check('un cœur soigne quand on est blessé', hero.hp >= 5 + heal - 1, `${hero.hp} PV`)
}

// --- salles typées : la forme ne ment pas -----------------------------------
{
  const kinds = new Set<string>()
  let lies = 0
  let treasures = 0
  let isolated = 0
  for (const seed of [11, 222, 3333, 44444, 20260808]) {
    const layout = generateFloor(new Rng(seed), 5)
    let tresorHere = 0
    for (const r of layout.rooms) {
      kinds.add(r.kind)
      const long = Math.max(r.w, r.h)
      const short = Math.min(r.w, r.h)
      if (r.kind === 'galerie' && (long < 10 || long < short * 2.2)) lies++
      if ((r.kind === 'arene' || r.kind === 'piliers') && (r.w < 9 || r.h < 9)) lies++
      if (r.kind === 'tresor') tresorHere++
    }
    if (tresorHere > 1) lies++
    treasures += tresorHere

    // Les piliers ne doivent isoler aucune case : BFS sur tout le praticable.
    const seen2 = new Uint8Array(MAP_W * MAP_H)
    const q = [layout.spawn.y * MAP_W + layout.spawn.x]
    seen2[q[0]!] = 1
    let h2 = 0
    while (h2 < q.length) {
      const idx = q[h2++]!
      const x = idx % MAP_W
      const y = (idx / MAP_W) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = (y + dy) * MAP_W + (x + dx)
        if (x + dx < 0 || y + dy < 0 || x + dx >= MAP_W || y + dy >= MAP_H) continue
        if (seen2[ni] || !isWalkable(layout.tiles[ni]!)) continue
        seen2[ni] = 1
        q.push(ni)
      }
    }
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      if (isWalkable(layout.tiles[i]!) && !seen2[i]) isolated++
    }
  }
  check('les types de salle sortent tous', kinds.size >= 4, [...kinds].join(', '))
  check('aucun type ne ment sur sa forme', lies === 0, `${lies} mensonge(s)`)
  check('des salles au trésor existent en profondeur', treasures >= 1, `${treasures} sur 5 graines`)
  check('les piliers n\'isolent aucune case', isolated === 0, `${isolated} case(s) coupée(s)`)
  const early = generateFloor(new Rng(77), 1)
  check('pas de salle piégée à l\'étage 1', !early.rooms.some((r) => r.kind === 'tresor'))
}

// --- salle piégée : un pari, pas une embuscade ------------------------------
{
  // On cherche une graine dont l'étage 3 a une salle piégée.
  let s: GameState | null = null
  for (const seed of [101, 202, 303, 404, 505, 606]) {
    const cand = createGame(seed)
    addPlayer(cand, 'p_trap', 'Parieur')
    clearMonsters(cand)
    descend(cand)
    clearMonsters(cand)
    descend(cand)
    clearMonsters(cand)
    if (cand.trap) {
      s = cand
      break
    }
  }
  check('une salle piégée finit par apparaître', s !== null)
  if (s) {
    const trap = s.trap!
    const hero = s.actors['p_trap']!
    const room = trap.room
    check('sa récompense est posée dedans', s.items.some(
      (i) => i.kind === 'weapon' && i.x >= room.x && i.x < room.x + room.w,
    ))

    // Entrer allume les braseros…
    hero.x = room.x + room.w / 2
    hero.y = room.y + room.h / 2
    step(s, noInputs)
    check('entrer déclenche l\'avertissement', trap.phase === 'warning')
    check('l\'avertissement est annoncé', s.events.some((e) => e.t === 'trapwarn'))

    // …ressortir à temps refuse le pari.
    hero.x = room.x - 3
    for (let i = 0; i < TRAP_WARNING_TICKS + 2; i++) step(s, noInputs)
    check('ressortir à temps réarme le piège', trap.phase === 'armed')

    // Rester : la grille tombe, une vague apparaît dans la salle.
    hero.x = room.x + room.w / 2
    hero.hp = hero.maxHp
    for (let i = 0; i < TRAP_WARNING_TICKS + 3; i++) step(s, noInputs)
    check('rester fait tomber la grille', trap.phase === 'sprung')
    check('la grille est posée en tuiles', trap.gates.length > 0 &&
      trap.gates.every((g) => s!.tiles[g.y * s!.width + g.x] === Tile.Gate), `${trap.gates.length} tuile(s)`)
    const inside = Object.values(s.actors).filter(
      (a) => a.kind === 'monster' && a.alive &&
        a.x >= room.x && a.x < room.x + room.w && a.y >= room.y && a.y < room.y + room.h,
    )
    check('la vague apparaît dans la salle', inside.length >= 3, `${inside.length} monstre(s)`)
    check('la vague grossit avec l\'étage', trapWaveSize(10) > trapWaveSize(3),
      `${trapWaveSize(3)} -> ${trapWaveSize(10)}`)

    // Salle nettoyée : la grille se relève, et c'est fini.
    clearMonsters(s)
    step(s, noInputs)
    check('salle vide : la grille se relève', trap.phase === 'done' &&
      trap.gates.length === 0 && s.events.some((e) => e.t === 'trapclear'))
  }
}

// --- ossements : la monnaie de la descente ----------------------------------
{
  const s = createGame(3131)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_os', 'Fossoyeur')
  hero.weapon = 'spear'
  s.items.length = 0

  const victim = putMonster(s, 'm_os', 'skeleton', hero.x + 2.2, hero.y)
  victim.hp = 1
  step(s, { p_os: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  check('un monstre tué laisse des ossements', s.items.some((i) => i.kind === 'bone'))
  for (let i = 0; i < TICK_RATE * 2; i++) step(s, noInputs)
  check('les ossements sont aimantés et rejoignent la bourse', s.bones === BONE_PER_KILL, `${s.bones}`)

  // Une élite paie mieux qu'un troupier.
  const elite = putMonster(s, 'm_elite', 'skeleton', hero.x + 2.2, hero.y)
  elite.elite = true
  elite.hp = 1
  step(s, { p_os: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  for (let i = 0; i < TICK_RATE * 2; i++) step(s, noInputs)
  check('une élite laisse plus d\'ossements', s.bones === BONE_PER_KILL + BONE_ELITE, `${s.bones}`)

  check('le prix du coffre monte avec l\'étage', chestPrice(10) > chestPrice(1),
    `${chestPrice(1)} -> ${chestPrice(10)}`)

  // Trop pauvre : le coffre reste fermé, la bourse intacte.
  s.items.length = 0
  s.bones = chestPrice(s.floor) - 1
  s.items.push({ id: 'i_chest', kind: 'chest', x: hero.x, y: hero.y })
  for (let i = 0; i < 3; i++) step(s, noInputs)
  check('un coffre trop cher reste fermé', s.items.some((i) => i.id === 'i_chest'))
  check('et la bourse est intacte', s.bones === chestPrice(s.floor) - 1, `${s.bones}`)

  // Assez riche : il s'ouvre, débite le prix, et crache arme + cœur.
  s.bones = chestPrice(s.floor)
  hero.hp = hero.maxHp // le cœur craché doit rester au sol, pas fausser le compte
  step(s, noInputs)
  const spent = s.events.find((e) => e.t === 'spend')
  check('un coffre payé s\'ouvre et débite la bourse', !s.items.some((i) => i.id === 'i_chest') && s.bones === 0, `solde ${s.bones}`)
  check('la dépense est annoncée', spent !== undefined && spent.amount === chestPrice(s.floor))
  check('le coffre crache une arme et un cœur',
    s.items.some((i) => i.kind === 'weapon') && s.items.some((i) => i.kind === 'heart'))

  // La bourse survit à la descente : c'est une ressource de la partie, pas de l'étage.
  s.bones = 17
  descend(s)
  check('les ossements passent l\'escalier', s.bones === 17, `${s.bones}`)
}

// --- signal lent : l'usure biaise, elle ne déclenche pas ---------------------
{
  const s = createGame(4141)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_use', 'Fatigué')
  step(s, noInputs)
  check('une équipe fraîche n\'a pas d\'usure', slowStrain(s) < 0.1, slowStrain(s).toFixed(2))

  // On simule une descente éprouvante : la moitié du temps sous le seuil,
  // des mises à terre, des PV bas.
  hero.hp = Math.round(hero.maxHp * 0.2)
  s.wear.ticks = 10000
  s.wear.lowTicks = 5000
  s.wear.downs = 3
  const worn = slowStrain(s)
  check('l\'usure monte avec la descente', worn > 0.5, worn.toFixed(2))

  // Le biais : à usure maximale, la Directrice attend plus longtemps.
  const fresh = createDirector(0, 1)
  const tired = createDirector(0, 1)
  const calm = { damageFraction: 0, engaged: 0, downed: false, available: 10 }
  let freshAt = -1
  let tiredAt = -1
  for (let t = 1; t < TICK_RATE * 60; t++) {
    if (freshAt < 0 && updateDirector(fresh, t, { ...calm, strain: 0 }) > 0) freshAt = t
    if (tiredAt < 0 && updateDirector(tired, t, { ...calm, strain: 1 }) > 0) tiredAt = t
    if (freshAt >= 0 && tiredAt >= 0) break
  }
  check('l\'usure allonge la patience de la Directrice', tiredAt > freshAt,
    `${freshAt} -> ${tiredAt} ticks`)
}

// --- salle de repos : le répit se mérite ------------------------------------
{
  const s = createGame(5151)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_rest', 'Épuisé')

  // Sans usure : pas de salle de repos.
  descend(s)
  check('pas de repos pour une équipe fraîche', !s.rooms.some((r) => r.kind === 'repos'))
  clearMonsters(s)

  // Usure maximale : le prochain étage propose le répit.
  hero.hp = Math.max(1, Math.round(hero.maxHp * 0.1))
  s.wear.ticks = 10000
  s.wear.lowTicks = 7000
  s.wear.downs = 4
  descend(s)
  const rest = s.rooms.find((r) => r.kind === 'repos')
  check('l\'usure mérite une salle de repos', rest !== undefined)
  if (rest) {
    const stall = s.items.filter((i) => i.price !== undefined)
    check('l\'étal propose quatre objets à prix affiché', stall.length === 4, `${stall.length}`)
    check('aucun monstre dans la salle de repos', !Object.values(s.actors).some(
      (a) => a.kind === 'monster' &&
        a.x >= rest.x && a.x < rest.x + rest.w && a.y >= rest.y && a.y < rest.y + rest.h,
    ))

    // L'étal se paie. Le soin d'abord : il ramène au plafond, pas au-delà.
    const soin = s.items.find((i) => i.kind === 'soin')!
    s.bones = 200
    const before = s.bones
    hero.x = soin.x
    hero.y = soin.y
    step(s, noInputs)
    const ceiling = Math.round(hero.maxHp * healCapOf(s))
    check('le soin ramène au plafond courant', hero.hp === ceiling, `${hero.hp}/${ceiling}`)
    check('et il se paie', s.bones < before, `${before} -> ${s.bones}`)

    // Le plafond : l'achat permanent, au prix qui monte.
    const capBefore = healCapOf(s)
    const cap = s.items.find((i) => i.kind === 'cap')!
    hero.x = cap.x
    hero.y = cap.y
    step(s, noInputs)
    check('remonter le plafond marche', healCapOf(s) > capBefore,
      `${(capBefore * 100).toFixed(0)} % -> ${(healCapOf(s) * 100).toFixed(0)} %`)
    check('le prochain plafond coûtera plus cher', capPrice(s.capBought) > capPrice(0),
      `${capPrice(0)} -> ${capPrice(s.capBought)}`)

    // La fiole : une fente, une touche.
    const fiole = s.items.find((i) => i.kind === 'fiole_vitesse')!
    hero.x = fiole.x
    hero.y = fiole.y
    step(s, noInputs)
    check('la fiole va dans la fente', hero.potion === 'vitesse', String(hero.potion))
    const speedBefore = playerSpeed(hero)
    step(s, { p_rest: { ...NEUTRAL_INPUT, drink: true } })
    check('boire vide la fente et accélère', hero.potion === undefined &&
      (hero.hasteUntil ?? 0) > s.tick, `hâte jusqu'au tick ${hero.hasteUntil}`)
    check('la vitesse de fiole est réelle', playerSpeed(hero, 1, false, true) > speedBefore)

    // Deux repos coup sur coup : refusé, même laminé.
    s.wear.lowTicks = s.wear.ticks
    clearMonsters(s)
    descend(s)
    check('pas deux repos coup sur coup', !s.rooms.some((r) => r.kind === 'repos'))
  }
}

// --- échange d'arme : pas de va-et-vient infini -----------------------------
{
  const s = createGame(2525)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_swap', 'Échangeur')
  s.items.length = 0
  s.items.push({ id: 'i_axe', kind: 'weapon', x: hero.x, y: hero.y, weapon: 'axe' })

  const take: PlayerInput = { ...idle, take: true }
  step(s, { p_swap: take })
  check('demander une arme l\'équipe', hero.weapon === 'axe', String(hero.weapon))
  check('l\'ancienne arme reste au sol', s.items.some((i) => i.weapon === 'sword'))

  // En restant planté dessus, on ne doit pas réenchaîner les échanges — même
  // en maintenant la touche : le verrou de pose tient jusqu'à ce qu'on parte.
  for (let i = 0; i < TICK_RATE * 3; i++) step(s, { p_swap: take })
  check('rester sur l\'arme posée ne la reprend pas', hero.weapon === 'axe', String(hero.weapon))

  // En s'éloignant puis en revenant, si — mais toujours sur demande. On laisse
  // d'abord expirer le tampon de la dernière pression, sinon c'est elle qu'on
  // mesurerait et non l'absence de demande.
  hero.x += 4
  for (let i = 0; i < TAKE_BUFFER + 2; i++) step(s, noInputs)
  hero.x -= 4
  for (let i = 0; i < 3; i++) step(s, noInputs)
  check('y revenir sans rien demander ne reprend rien', hero.weapon === 'axe', String(hero.weapon))
  step(s, { p_swap: take })
  check('revenir et demander la reprend', hero.weapon === 'sword', String(hero.weapon))
}

// --- l'XP est commune à l'équipe --------------------------------------------
// Sinon celui qui frappe distance les autres et le donjon devient injouable
// pour la moitié du groupe.
{
  const s = createGame(2424)
  clearMonsters(s)
  const front = addPlayer(s, 'p_front', 'Devant')
  const back = addPlayer(s, 'p_back', 'Derrière')
  back.x = front.x + 5
  back.y = front.y

  s.items.push({ id: 'i_share', kind: 'xp', x: front.x, y: front.y, amount: 12 })
  step(s, noInputs)
  check('l\'XP profite à toute l\'équipe', (back.xp ?? 0) === (front.xp ?? 0) && (back.xp ?? 0) === 12,
    `devant ${front.xp}, derrière ${back.xp}`)
}

// --- structure d'étage : la clé du gardien ----------------------------------
{
  const s = createGame(2222)
  check('l\'escalier démarre verrouillé', s.stairsLocked)

  const keeper = Object.values(s.actors).find((a) => a.elite || a.boss)
  check('un gardien est posé sur l\'étage', keeper !== undefined)
  check('le gardien est plus coriace qu\'un monstre normal',
    (keeper?.maxHp ?? 0) > (MONSTERS[keeper?.species ?? '']?.maxHp ?? 0))
  check('des coffres sont placés', s.items.some((i) => i.kind === 'chest'))

  const hero = addPlayer(s, 'p_key', 'Porteur')
  // On amène le héros sur l'escalier avant d'avoir la clé : il ne descend pas.
  hero.x = s.stairs.x + 0.5
  hero.y = s.stairs.y + 0.5
  const floorBefore = s.floor
  step(s, noInputs)
  check('on ne descend pas sans la clé', s.floor === floorBefore)

  // Le gardien meurt : la clé tombe et se ramasse. On s'écarte de l'escalier
  // d'abord, sinon on descend dans la foulée.
  hero.x = s.spawn.x + 0.5
  hero.y = s.spawn.y + 0.5
  if (keeper) {
    keeper.x = hero.x + 0.6
    keeper.y = hero.y
    keeper.hp = 1
    hero.weapon = 'axe'
    hero.readyAt = s.tick
    for (let i = 0; i < TICK_RATE && s.stairsLocked; i++) {
      step(s, { p_key: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
    }
  }
  check('tuer le gardien déverrouille l\'escalier', !s.stairsLocked)

  hero.x = s.stairs.x + 0.5
  hero.y = s.stairs.y + 0.5
  step(s, noInputs)
  check('on descend une fois la clé prise', s.floor === floorBefore + 1)
  check('l\'étage suivant est de nouveau verrouillé', s.stairsLocked)
}

// --- un boss tous les BOSS_EVERY étages -------------------------------------
{
  const s = createGame(2323, 5)
  const boss = Object.values(s.actors).find((a) => a.boss)
  check('l\'étage 5 a un boss', boss !== undefined, boss?.name)
  check('le boss est vraiment gros', (boss?.maxHp ?? 0) > 200, `${boss?.maxHp} PV`)
}

// --- poursuite : ce qu'on n'a pas tué descend derrière nous -----------------
{
  const s = createGame(777)
  addPlayer(s, 'p_run', 'Fuyard')
  clearMonsters(s)

  const wounded = putMonster(s, 'm_a', 'orc', s.stairs.x + 1.5, s.stairs.y + 0.5)
  wounded.hp = 3
  for (let i = 0; i < 6; i++) {
    putMonster(s, `m_s${i}`, 'skeleton', s.stairs.x + 2.5 + i * 0.6, s.stairs.y + 0.5)
  }
  putMonster(s, 'm_o', 'orc', s.stairs.x + 7, s.stairs.y + 0.5)

  descend(s)

  check('les monstres laissés en vie suivent', s.pursuers.length === 8, `${s.pursuers.length}`)
  check(
    'ils ne débarquent pas dans la foulée',
    s.pursuers.every((p) => !(p.actor.id in s.actors)),
  )
  check(
    'ils gardent leurs blessures',
    s.pursuers.find((p) => p.actor.id === 'm_a')?.actor.hp === 3,
  )
  check('la descente annonce la poursuite', s.events.some((e) => e.t === 'pursuit'))

  // La dette ne se paie plus à l'escalier d'arrivée : elle est confiée à la
  // Directrice, qui la livre quand elle décide. Camper la sortie ne sert donc
  // plus à rien — c'était exactement l'exploit à supprimer.
  //
  // On isole la dette : ni monstres posés, ni réserve. Et on efface à chaque
  // tick ce qui vient d'être livré, parce qu'on teste la livraison et pas le
  // combat : un cobaye qui reste entouré garde une intensité au plafond, et une
  // Directrice qui ne livre plus rien dans ces conditions fait son travail.
  clearMonsters(s)
  s.reserveCount = 0

  const hordes: { tick: number; count: number; x: number; y: number }[] = []
  for (let i = 1; i <= TICK_RATE * 120; i++) {
    step(s, noInputs)
    for (const ev of s.events) {
      if (ev.t === 'horde') hordes.push({ tick: i, count: ev.count, x: ev.x, y: ev.y })
    }
    clearMonsters(s)
  }

  check('la Directrice finit par livrer', hordes.length > 0, `${hordes.length} vague(s)`)
  check(
    'la première vague est un groupe, pas un traînard',
    (hordes[0]?.count ?? 0) >= HORDE_MIN,
    `${hordes[0]?.count}`,
  )
  check(
    'toute la dette finit par être dépensée',
    s.pursuers.length === 0 && hordes.reduce((a, h) => a + h.count, 0) === 8,
    `${s.pursuers.length} restant(s)`,
  )
  const player = s.actors.p_run!
  check(
    'elle ne livre jamais dans les jambes du joueur',
    hordes.every((h) => Math.hypot(h.x - player.x, h.y - player.y) >= 3),
  )
}

// Une vague ne tombe pas sous les yeux du joueur : elle débouche.
{
  const s = createGame(7771)
  addPlayer(s, 'p_eye', 'Guetteur')
  clearMonsters(s)
  s.actors.p_eye!.maxHp = 9000
  s.actors.p_eye!.hp = 9000
  s.reserveCount = 12
  s.director = createDirector(s.tick)

  let sighted = 0
  let waves = 0
  for (let i = 0; i < TICK_RATE * 60; i++) {
    const { visible } = step(s, noInputs)
    for (const ev of s.events) {
      if (ev.t !== 'horde') continue
      waves++
      const idx = Math.floor(ev.y) * s.width + Math.floor(ev.x)
      if (visible[idx]) sighted++
    }
  }
  check('des vagues arrivent sur un étage en réserve', waves > 0, `${waves}`)
  check('aucune n\'apparaît dans le champ de vision', sighted === 0, `${sighted} vue(s)`)
}

// La politique seule, sans donjon : c'est là qu'on vérifie l'onde.
{
  const d = createDirector(0)
  const calm = { damageFraction: 0, engaged: 0, downed: false, available: 20 }

  let first = -1
  for (let t = 1; t <= TICK_RATE * 30 && first < 0; t++) {
    if (updateDirector(d, t, calm) > 0) first = t
  }
  check('le calme finit par déclencher une vague', first > 0, `tick ${first}`)
  check('mais pas immédiatement', first >= DIRECTOR_PATIENCE, `tick ${first}`)

  // Une équipe qui encaisse ne se voit rien ajouter : c'est la moitié du
  // modèle. Sans ça on empile jusqu'à l'écœurement.
  const hot = createDirector(0)
  let deliveredWhileHot = 0
  for (let t = 1; t <= TICK_RATE * 30; t++) {
    deliveredWhileHot += updateDirector(hot, t, {
      damageFraction: 0.05,
      engaged: 4,
      downed: false,
      available: 20,
    })
  }
  check('sous le feu, elle n\'ajoute rien', deliveredWhileHot === 0)
  check('et elle est passée par le pic', hot.phase !== 'buildup', hot.phase)

  // Le repos est garanti : rien ne peut le raccourcir, c'est lui qui donne sa
  // valeur au pic suivant.
  const resting = createDirector(0)
  resting.phase = 'rest'
  resting.since = 0
  let deliveredWhileResting = 0
  for (let t = 1; t < DIRECTOR_REST; t++) {
    deliveredWhileResting += updateDirector(resting, t, calm)
  }
  check('le repos ne peut pas être écourté', deliveredWhileResting === 0)
  updateDirector(resting, DIRECTOR_REST, calm)
  const afterRest: string = resting.phase
  check('et il finit', afterRest === 'buildup', afterRest)

  // Aucune phase ne doit pouvoir se bloquer sur une condition d'état seule.
  // `fade` n'attendait que « l'intensité repasse sous le seuil de calme » ; la
  // présence des monstres alimentant l'intensité, la condition ne pouvait plus
  // devenir vraie et la Directrice se taisait pour le reste de l'étage.
  {
    const besieged = createDirector(0, 1)
    const swarm = { damageFraction: 0, engaged: 8, downed: false, available: 20 }
    const seen = new Set<string>()
    let previous: string = besieged.phase
    let cycles = 0
    for (let t = 1; t <= TICK_RATE * 300; t++) {
      updateDirector(besieged, t, swarm)
      seen.add(besieged.phase)
      if (previous !== 'buildup' && besieged.phase === 'buildup') cycles++
      previous = besieged.phase
    }
    check(
      'assiégée, elle boucle quand même son cycle',
      cycles >= 2 && seen.size === 4,
      `${cycles} cycle(s), phases vues : ${[...seen].join(', ')}`,
    )
  }

  // Un traînard n'est pas un combat. Il tenait pourtant l'intensité à 0,333,
  // au-dessus du seuil de calme, et suspendait toute livraison tant qu'il
  // vivait — la Directrice n'agissait que sur un joueur strictement seul.
  {
    const nagged = createDirector(0, 2)
    let delivered = 0
    for (let t = 1; t <= TICK_RATE * 30; t++) {
      delivered += updateDirector(nagged, t, { ...calm, engaged: 1 })
    }
    check('un traînard ne suspend pas les livraisons', delivered > 0, `${delivered} monstre(s)`)
  }

  // Mais un vrai combat, si : c'est toute la différence entre présence subie et
  // pression réelle, et c'est ce que la séparation mémoire/présence permet
  // enfin d'exprimer.
  {
    const busy = createDirector(0, 3)
    let delivered = 0
    for (let t = 1; t <= TICK_RATE * 30; t++) {
      delivered += updateDirector(busy, t, { ...calm, engaged: 4 })
    }
    check('mais quatre adversaires, oui', delivered === 0)
  }

  // La présence ne laisse pas de trace : une salle vidée doit rendre la main
  // tout de suite, sinon reculer pour souffler ne paie qu'au bout de plusieurs
  // secondes et le joueur ne fait pas le lien.
  {
    const cleared = createDirector(0, 4)
    for (let t = 1; t <= TICK_RATE * 20; t++) {
      updateDirector(cleared, t, { ...calm, engaged: 6 })
    }
    check('la présence ne laisse aucune trace', cleared.intensity < 0.01)
  }

  // La taille d'une vague doit dépendre de la graine. Elle ne dépendait que du
  // tick, et la première livraison tombe toujours au même tick : cinq parties
  // différentes sortaient cinq vagues identiques.
  {
    const sizes = new Set<number>()
    for (let seed = 1; seed <= 40; seed++) {
      const d2 = createDirector(0, seed * 7919)
      for (let t = 1; t <= TICK_RATE * 30; t++) {
        const n = updateDirector(d2, t, calm)
        if (n > 0) {
          sizes.add(n)
          break
        }
      }
    }
    check(
      'la taille de la première vague varie avec la graine',
      sizes.size >= 3,
      `${sizes.size} taille(s) distincte(s) sur 40 graines : ${[...sizes].sort().join(', ')}`,
    )
  }

  // Sans munitions, elle patiente au lieu de livrer du vide.
  const dry = createDirector(0)
  let deliveredDry = 0
  for (let t = 1; t <= TICK_RATE * 30; t++) {
    deliveredDry += updateDirector(dry, t, { ...calm, available: 0 })
  }
  check('sans réserve, elle ne livre rien', deliveredDry === 0)
}

// Un étage nettoyé ne coûte rien : c'est ce qui rend la dette juste.
{
  const s = createGame(778)
  addPlayer(s, 'p_clean', 'Méthodique')
  clearMonsters(s)
  descend(s)
  check('nettoyer l\'étage n\'emmène aucun poursuivant', s.pursuers.length === 0)
  check('et rien n\'est annoncé', !s.events.some((e) => e.t === 'pursuit'))
}

// Sans plafond, sauter trois étages d'affilée construit un mur infranchissable.
{
  const s = createGame(779)
  addPlayer(s, 'p_lazy', 'Négligent')
  clearMonsters(s)
  for (let i = 0; i < PURSUE_MAX + 9; i++) {
    putMonster(s, `m_h${i}`, 'skeleton', s.stairs.x + 1.5 + i * 0.01, s.stairs.y + 0.5)
  }
  descend(s)
  check(
    'le nombre de poursuivants est plafonné',
    s.pursuers.length === PURSUE_MAX,
    `${s.pursuers.length} pour ${PURSUE_MAX + 9} laissés`,
  )
}

// --- le modèle de puissance -------------------------------------------------
// Ces tests ne vérifient pas un comportement, ils verrouillent des invariants
// de conception. Ce sont eux qui empêchent de revenir en arrière sans le voir.
{
  const dpsOf = (id: string, level: number) => {
    const w = WEAPONS[id]!
    return (w.damage * playerAttackMult(level)) / (w.cooldown / TICK_RATE)
  }
  const ids = Object.keys(WEAPONS)

  const dps1 = ids.map((id) => dpsOf(id, 1))
  check(
    'toutes les armes ont le même DPS nominal',
    Math.max(...dps1) / Math.min(...dps1) < 1.02,
    dps1.map((d) => d.toFixed(1)).join(' / '),
  )

  // Le défaut qui a produit 89 % des dégâts d'une descente à la dague : en
  // additif, l'écart entre deux armes s'effondre à mesure que le niveau monte.
  const ratio = (level: number) => dpsOf('axe', level) / dpsOf('dagger', level)
  check(
    'l\'écart entre deux armes se conserve à tous les niveaux',
    Math.abs(ratio(30) - ratio(1)) < 0.01,
    `n1 ×${ratio(1).toFixed(3)} → n30 ×${ratio(30).toFixed(3)}`,
  )

  // L'invariant central : un monstre de base doit mettre le même temps à mourir
  // à l'étage 20 qu'à l'étage 1, si le joueur a progressé au rythme prévu.
  const orc = MONSTERS.orc!
  const ttkAt = (floor: number) => {
    const level = Math.round(1 + LEVELS_PER_FLOOR * (floor - 1))
    return (orc.maxHp * floorScale(floor, FLOOR_HP_GROWTH)) / dpsOf('sword', level)
  }
  const ttks = [1, 5, 10, 15, 20].map(ttkAt)
  check(
    'le TTK reste constant sur 20 étages',
    Math.max(...ttks) / Math.min(...ttks) < 1.02,
    ttks.map((t) => t.toFixed(2)).join(' / '),
  )
  check(
    'le TTK est sur sa cible',
    Math.abs(ttkAt(1) - TARGET_TTK) < 0.1,
    `${ttkAt(1).toFixed(2)}s pour une cible de ${TARGET_TTK}s`,
  )

  // Les PV effectifs doivent croître linéairement avec l'armure — c'est la
  // propriété qui rend a/(a+k) sûre, et qui permettra d'empiler sans emballement.
  const gain = (a: number) => effectiveHp(100, a) / effectiveHp(100, 0)
  check(
    'les PV effectifs croissent linéairement avec l\'armure',
    Math.abs((gain(120) - 1) / (gain(60) - 1) - 2) < 0.001,
    `+${((gain(60) - 1) * 100).toFixed(0)}% à 60, +${((gain(120) - 1) * 100).toFixed(0)}% à 120`,
  )
  check('sans armure, les PV effectifs sont les PV', effectiveHp(100) === 100)
}

// La montée en niveau applique bien le modèle multiplicatif.
{
  const s = createGame(4242)
  const hero = addPlayer(s, 'p_lvl', 'Cobaye')
  clearMonsters(s)
  const hpAt1 = hero.maxHp
  const dmgAt1 = Math.round(WEAPONS.sword!.damage * playerAttackMult(hero.level ?? 1))

  hero.xp = xpForLevel(10)
  // Un ramassage d'orbe déclenche la montée : on en pose une sous ses pieds.
  s.items.push({ id: 'xp_test', kind: 'xp', x: hero.x, y: hero.y, amount: 1 })
  step(s, noInputs)

  check('le héros monte de niveau', (hero.level ?? 1) >= 10, `niveau ${hero.level}`)
  check(
    'ses PV suivent la formule, sans reliquat',
    hero.maxHp === playerMaxHp(hero.level ?? 1),
    `${hero.maxHp} PV pour ${playerMaxHp(hero.level ?? 1)} attendus`,
  )
  const dmgNow = Math.round(WEAPONS.sword!.damage * playerAttackMult(hero.level ?? 1))
  check(
    'ses dégâts ont monté en facteur',
    dmgNow > dmgAt1 && Math.abs(dmgNow / dmgAt1 - ATK_GROWTH ** ((hero.level ?? 1) - 1)) < 0.15,
    `${dmgAt1} → ${dmgNow} (×${(dmgNow / dmgAt1).toFixed(2)})`,
  )
  check('ses PV ont monté aussi', hero.maxHp > hpAt1, `${hpAt1} → ${hero.maxHp}`)
}

// --- profils de style --------------------------------------------------------
// L'engine mesure comment chacun joue. Rien ne s'adapte encore : ces tests
// vérifient seulement que les chiffres décrivent bien ce qui s'est passé.
{
  // Portée : un coup de lance à 2 tuiles doit se mesurer ~2 tuiles.
  const s = createGame(3100)
  const hero = addPlayer(s, 'p_prof', 'Mesuré')
  clearMonsters(s)
  hero.weapon = 'spear'
  const target = putMonster(s, 'm_far', 'orc', hero.x + 2, hero.y)
  target.hp = 9999
  target.maxHp = 9999
  target.readyAt = 999999
  step(s, { p_prof: { mx: 0, my: 0, aim: 0, attack: true, sprint: false } })
  const range = profileStats(s.profiles.p_prof!).range
  check('la portée mesure la distance du coup', range !== null && Math.abs(range - 2) < 0.5, `${range?.toFixed(2)} t`)
}

{
  // Mobilité : immobile en combat ≈ 0, en cerclant > 1 t/s. Le monstre est
  // engagé (≤ 6 tuiles) mais hors de portée de coup, pour ne pas polluer la
  // mesure de recul.
  const still = createGame(3101)
  const h1 = addPlayer(still, 'p_still', 'Statue')
  clearMonsters(still)
  const m1 = putMonster(still, 'm_watch', 'skeleton', h1.x + 5, h1.y)
  m1.readyAt = 999999
  for (let i = 0; i < TICK_RATE * 2; i++) {
    m1.x = h1.x + 5
    m1.y = h1.y
    step(still, { p_still: idle })
  }
  const still_mob = profileStats(still.profiles.p_still!).mobility

  const moving = createGame(3101)
  const h2 = addPlayer(moving, 'p_move', 'Danseur')
  clearMonsters(moving)
  const m2 = putMonster(moving, 'm_watch2', 'skeleton', h2.x + 5, h2.y)
  m2.readyAt = 999999
  for (let i = 0; i < TICK_RATE * 2; i++) {
    m2.x = h2.x + 5
    m2.y = h2.y
    const angle = (i / (TICK_RATE * 2)) * Math.PI * 4
    step(moving, { p_move: { mx: Math.cos(angle), my: Math.sin(angle), aim: 0, attack: false, sprint: false } })
  }
  const move_mob = profileStats(moving.profiles.p_move!).mobility

  check('immobile, la mobilité est nulle', still_mob !== null && still_mob < 0.3, `${still_mob?.toFixed(2)} t/s`)
  check('en cerclant, elle se voit', move_mob !== null && move_mob > 1, `${move_mob?.toFixed(2)} t/s`)
}

{
  // Encombrement : encaisser entouré de trois doit compter trois.
  const s = createGame(3102)
  const hero = addPlayer(s, 'p_crowd', 'Cerné')
  hero.invulnUntil = 0 // pas de grâce d'apparition : on teste la mesure, pas la survie
  clearMonsters(s)
  for (let i = 0; i < 3; i++) {
    putMonster(s, `m_c${i}`, 'skeleton', hero.x + 1.2 * Math.cos((i * 2 * Math.PI) / 3), hero.y + 1.2 * Math.sin((i * 2 * Math.PI) / 3))
  }
  for (let i = 0; i < TICK_RATE * 3; i++) {
    step(s, { p_crowd: idle })
    if ((s.profiles.p_crowd?.hitsTakenCount ?? 0) > 0) break
  }
  const crowding = profileStats(s.profiles.p_crowd!).crowding
  check('l\'encombrement compte les assaillants', crowding !== null && crowding >= 2.5, `${crowding?.toFixed(1)}`)
}

{
  // Cohésion : nulle en solo, mesurée à deux.
  const solo = createGame(3103)
  addPlayer(solo, 'p_solo', 'Ermite')
  clearMonsters(solo)
  const ms = putMonster(solo, 'm_s', 'skeleton', solo.actors.p_solo!.x + 4, solo.actors.p_solo!.y)
  ms.readyAt = 999999
  for (let i = 0; i < TICK_RATE; i++) step(solo, { p_solo: idle })
  check('la cohésion reste vide en solo', profileStats(solo.profiles.p_solo!).cohesion === null)

  const duo = createGame(3103)
  const a = addPlayer(duo, 'p_a', 'Alice')
  const b = addPlayer(duo, 'p_b', 'Basile')
  clearMonsters(duo)
  b.x = a.x + 2
  b.y = a.y
  const md = putMonster(duo, 'm_d', 'skeleton', a.x + 4, a.y)
  md.readyAt = 999999
  for (let i = 0; i < TICK_RATE; i++) {
    b.x = a.x + 2
    b.y = a.y
    step(duo, { p_a: idle, p_b: idle })
  }
  const cohesion = profileStats(duo.profiles.p_a!).cohesion
  check('à deux, la cohésion mesure la distance', cohesion !== null && Math.abs(cohesion - 2) < 0.5, `${cohesion?.toFixed(2)} t`)
}

{
  // Patience : descendre en laissant la moitié doit se lire dans le profil.
  const s = createGame(3104)
  addPlayer(s, 'p_pat', 'Pressé')
  clearMonsters(s)
  s.reserveCount = 0
  s.floorKills = 5
  putMonster(s, 'm_left1', 'skeleton', s.stairs.x + 3, s.stairs.y)
  putMonster(s, 'm_left2', 'skeleton', s.stairs.x + 4, s.stairs.y)
  putMonster(s, 'm_left3', 'skeleton', s.stairs.x + 5, s.stairs.y)
  putMonster(s, 'm_left4', 'skeleton', s.stairs.x + 6, s.stairs.y)
  putMonster(s, 'm_left5', 'skeleton', s.stairs.x + 7, s.stairs.y)
  descend(s)
  const patience = profileStats(s.profiles.p_pat!).patience
  check('la patience mesure la part tuée', patience !== null && Math.abs(patience - 0.5) < 0.01, `${((patience ?? 0) * 100).toFixed(0)} %`)
}

{
  // Déterminisme : les profils n'introduisent aucune divergence entre deux
  // parties de même graine — et sont eux-mêmes identiques au bit près.
  const runOne = (): string => {
    const s = createGame(3105)
    addPlayer(s, 'p_det', 'Jumeau')
    const input: PlayerInput = { mx: 1, my: 0.3, aim: 1, attack: true, sprint: false }
    for (let i = 0; i < TICK_RATE * 5; i++) step(s, { p_det: input })
    return JSON.stringify({ profiles: s.profiles, tick: s.tick, rng: s.rng, actors: Object.keys(s.actors).length })
  }
  check('deux parties de même graine ont le même profil', runOne() === runOne())
}

// --- recettes de vagues ------------------------------------------------------
// La Directrice décide quand, la recette décide quoi et où. Politique pure
// d'abord : tout se teste sans donjon.
{
  // Le repli ne rend jamais un comportement introuvable, quel que soit l'étage.
  const pools: Behavior[][] = [1, 2, 3, 4, 6, 10].map((floor) => {
    const s = createGame(4000 + floor, floor)
    const seen = new Set<Behavior>()
    for (const a of Object.values(s.actors)) {
      if (a.kind === 'monster') seen.add(MONSTERS[a.species]!.behavior)
    }
    // Le pool réel de l'étage, pas les monstres posés : on le reconstruit.
    return [...seen]
  })
  const wanted: Behavior[] = ['melee', 'archer', 'charger', 'swarm', 'bomber']
  let allResolved = true
  for (const pool of pools) {
    const available = new Set(pool)
    for (const w of wanted) {
      if (!available.has(resolveBehavior(w, available))) allResolved = false
    }
  }
  check('resolveBehavior rend toujours de l\'existant', allResolved)
  check(
    'l\'étage 1 replie archer sur ce qu\'il a',
    resolveBehavior('archer', new Set<Behavior>(['melee', 'swarm'])) === 'melee',
  )
}

{
  // Répartition d'effectif : exacte, jamais de groupe vide tant qu'il y a de quoi.
  const even = splitShares(6, [0.5, 0.5])
  check('splitShares partage exactement', even[0]! + even[1]! === 6 && even[0] === 3, even.join('/'))
  const tiny = splitShares(1, [0.5, 0.5])
  check('à un seul monstre, un seul groupe', tiny[0] === 1 && tiny[1] === 0, tiny.join('/'))
  const odd = splitShares(5, [0.5, 0.5])
  check('l\'impair ne perd personne', odd[0]! + odd[1]! === 5, odd.join('/'))
}

{
  // planWave : mono-espèce par groupe, et la dette sort toujours en premier —
  // même quand aucun poursuivant ne colle à la recette.
  const rng = new Rng(99)
  const pool = ['skeleton', 'bat', 'orc', 'skeleton_mage', 'skeleton_rogue']
  const debt = new Map([['orc', 2], ['skeleton', 3]])

  const snipers = RECIPES.find((r) => r.name === 'tireurs')!
  const plan = planWave(snipers, 5, pool, debt, rng)
  const debtSpent = plan.reduce((a, g) => a + g.fromDebt, 0)
  // Une vague est mono-espèce par groupe : elle ne peut vider qu'une bannière
  // de dette à la fois. Le squelette (le mieux fourni) sort entier, l'orc
  // attendra la vague suivante — le drainage complet est testé en intégration.
  check('la dette sort même contre la recette', debtSpent === 3 && plan[0]?.species === 'skeleton', `${debtSpent} de dette, ${plan[0]?.species}`)
  check(
    'chaque groupe est mono-espèce et complet',
    plan.every((g) => g.fromDebt + g.fromReserve > 0) &&
      new Set(plan.map((g) => g.species)).size === plan.length,
  )

  const pincer = RECIPES.find((r) => r.name === 'clouage')!
  const plan2 = planWave(pincer, 6, pool, new Map(), new Rng(7))
  check('le clouage fait deux groupes', plan2.length === 2, `${plan2.length}`)
  check(
    'chargeurs et archers répondent à l\'appel',
    plan2.some((g) => MONSTERS[g.species]!.behavior === 'charger') &&
      plan2.some((g) => MONSTERS[g.species]!.behavior === 'archer'),
    plan2.map((g) => g.species).join(', '),
  )
}

{
  // Intégration : les vagues livrées portent une recette valide et restent
  // mono-espèce par groupe — on le lit sur les espèces livrées entre deux hordes.
  const s = createGame(7772, 6)
  const hero = addPlayer(s, 'p_rec', 'Testeur')
  clearMonsters(s)
  hero.maxHp = 9000
  hero.hp = 9000
  s.reserveCount = 30
  s.director = createDirector(s.tick)

  const names = new Set(RECIPES.map((r) => r.name))
  const seen: string[] = []
  let allValid = true
  for (let i = 0; i < TICK_RATE * 240 && seen.length < 4; i++) {
    step(s, noInputs)
    for (const ev of s.events) {
      if (ev.t !== 'horde') continue
      seen.push(ev.recipe)
      if (!names.has(ev.recipe as RecipeName)) allValid = false
    }
    clearMonsters(s)
  }
  check('les vagues portent leur recette', seen.length >= 2, `${seen.length} vague(s) : ${seen.join(', ')}`)
  check('toutes les recettes sont valides', allValid)
}

// --- le bandit ---------------------------------------------------------------
// La Directrice apprend : les recettes qui produisent de l'intensité sortent
// plus, celles qui ne font rien sortent moins — mais jamais zéro.
{
  // Politique pure : toutes les recettes sont essayées avant qu'aucune ne soit
  // répétée (le bénéfice du doute de l'UCB).
  const arms: BanditArms = {}
  const rng = new Rng(1)
  const firstRound = new Set<string>()
  for (let i = 0; i < RECIPES.length; i++) {
    // rng biaisé hors exploration : on force le chemin UCB en rejouant tant que
    // le tirage tombe dans la part d'exploration.
    let r = pickRecipe(arms, rng)
    for (let guard = 0; firstRound.has(r.name) && guard < 50; guard++) r = pickRecipe(arms, rng)
    firstRound.add(r.name)
    recordReward(arms, r.name, 0.5)
  }
  check('toutes les recettes sont essayées d\'abord', firstRound.size === RECIPES.length, `${firstRound.size}/${RECIPES.length}`)

  // Un levier qui paie sort plus souvent qu'un levier mort.
  const arms2: BanditArms = {}
  for (const r of RECIPES) recordReward(arms2, r.name, r.name === 'clouage' ? 0.9 : 0.05)
  const counts: Record<string, number> = {}
  const rng2 = new Rng(2)
  for (let i = 0; i < 300; i++) {
    const picked = pickRecipe(arms2, rng2)
    counts[picked.name] = (counts[picked.name] ?? 0) + 1
    recordReward(arms2, picked.name, picked.name === 'clouage' ? 0.9 : 0.05)
  }
  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!
  check('la recette qui marche domine', winner[0] === 'clouage' && winner[1] > 150, `${winner[0]} ×${winner[1]}`)
  check(
    'mais aucune recette ne meurt',
    RECIPES.every((r) => (counts[r.name] ?? 0) > 0),
    RECIPES.map((r) => `${r.name} ×${counts[r.name] ?? 0}`).join(', '),
  )
}

{
  // Intégration : après une vague, la fenêtre se referme et le levier de la
  // recette porte un gain.
  const s = createGame(8801, 6)
  const hero = addPlayer(s, 'p_learn', 'Élève')
  clearMonsters(s)
  hero.maxHp = 9000
  hero.hp = 9000
  s.reserveCount = 30
  s.director = createDirector(s.tick)

  let waves = 0
  for (let i = 0; i < TICK_RATE * 240; i++) {
    step(s, noInputs)
    for (const ev of s.events) if (ev.t === 'horde') waves++
    if (waves >= 2 && !s.banditPending) break
  }
  // La mémoire est contextuelle : joueur:arme (épée de départ ici).
  const arms = s.bandit['p_learn:sword'] ?? {}
  const pulls = Object.values(arms).reduce((a, b) => a + b.n, 0)
  check('les vagues inscrivent leur gain', pulls >= 1, `${pulls} tirage(s) inscrits pour ${waves} vague(s)`)
  check(
    'les gains restent dans [0, 1]',
    Object.values(arms).every((a) => a.sum >= 0 && a.sum <= a.n),
  )
}

// --- Sprint -------------------------------------------------------------------
//
// Le sprint doit rendre la traversée moins pénible sans devenir une esquive :
// on vérifie donc autant ce qu'il donne que ce qu'il refuse.
{
  console.log('\nSprint')

  /** Distance parcourue en `seconds` en poussant vers la droite. */
  function runFor(
    seconds: number,
    sprint: boolean,
    attack = false,
  ): { dist: number; hero: Actor; low: number } {
    const s = createGame(777)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_run', 'Coureur')
    // Une bande dégagée vers la droite, sinon on mesure un mur.
    for (let x = 0; x < MAP_W; x++) {
      s.tiles[Math.floor(hero.y) * MAP_W + x] = Tile.Floor
    }
    const start = hero.x
    const input: PlayerInput = { mx: 1, my: 0, aim: 0, attack, sprint }
    let low = 1
    for (let i = 0; i < Math.round(TICK_RATE * seconds); i++) {
      step(s, { p_run: input })
      low = Math.min(low, hero.stamina ?? 1)
    }
    return { dist: hero.x - start, hero, low }
  }

  const walk = runFor(1.5, false)
  const dash = runFor(1.5, true)
  check(
    'sprinter couvre plus de terrain que marcher',
    dash.dist > walk.dist * 1.4,
    `${walk.dist.toFixed(2)} -> ${dash.dist.toFixed(2)} tuiles`,
  )
  check(
    'et la jauge se vide en courant',
    (dash.hero.stamina ?? 1) < 0.6,
    `souffle ${(dash.hero.stamina ?? 1).toFixed(2)}`,
  )
  check('marcher ne coûte rien', (walk.hero.stamina ?? 0) === 1)

  // Le souffle est fini. En gardant la touche enfoncée on obtient une course
  // hachée par la récupération, pas six secondes de sprint : la distance doit
  // rester franchement entre la marche et le sprint continu.
  const long = runFor(6, true)
  check(
    'le souffle s\'épuise et la course retombe',
    long.low === 0 &&
      long.dist > PLAYER_SPEED * 6 &&
      long.dist < PLAYER_SPEED * SPRINT_MULT * 6 * 0.85,
    `${long.dist.toFixed(1)} tuiles en 6 s (marche ${(PLAYER_SPEED * 6).toFixed(1)}, ` +
      `sprint continu ${(PLAYER_SPEED * SPRINT_MULT * 6).toFixed(1)})`,
  )

  // Sprinter la lame sortie contournerait le coût de déplacement des armes.
  const swinging = runFor(1.5, true, true)
  check(
    'on ne sprinte pas en frappant',
    swinging.dist < dash.dist,
    `${swinging.dist.toFixed(2)} en frappant contre ${dash.dist.toFixed(2)}`,
  )

  // Régénération : elle ne démarre qu'après un temps mort.
  {
    const s = createGame(778)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_reg', 'Souffle')
    hero.stamina = 0.5
    hero.sprintedAt = s.tick
    hero.sprinting = false
    const before = hero.stamina
    for (let i = 0; i < SPRINT_REFILL_DELAY - 1; i++) step(s, { p_reg: idle })
    check('la jauge ne remonte pas tout de suite', hero.stamina === before)
    for (let i = 0; i < TICK_RATE * 2; i++) step(s, { p_reg: idle })
    check(
      'puis elle remonte',
      (hero.stamina ?? 0) > before + 0.3,
      `${before} -> ${(hero.stamina ?? 0).toFixed(2)}`,
    )
  }

  // Sous le seuil, on ne peut pas relancer : sinon le sprint devient un hachis.
  {
    const s = createGame(779)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_low', 'Essoufflé')
    for (let x = 0; x < MAP_W; x++) s.tiles[Math.floor(hero.y) * MAP_W + x] = Tile.Floor
    hero.stamina = SPRINT_MIN_START - 0.05
    hero.sprinting = false
    hero.sprintedAt = s.tick
    const start = hero.x
    const go: PlayerInput = { mx: 1, my: 0, aim: 0, attack: false, sprint: true }
    for (let i = 0; i < 10; i++) step(s, { p_low: go })
    check(
      'sous le seuil, la relance est refusée',
      hero.sprinting === false && hero.x - start < PLAYER_SPEED * SPRINT_MULT * (10 / TICK_RATE) * 0.95,
      `souffle ${(hero.stamina ?? 0).toFixed(2)}`,
    )
  }
}

// --- Interruption des attaques ------------------------------------------------
//
// Frapper un monstre qui prépare son coup le lui fait manquer. Sans garde-fou
// ce serait un verrou permanent, donc on vérifie surtout l'immunité qui suit.
{
  console.log('\nInterruption')

  /** Amène un monstre jusqu'au milieu de sa préparation, puis le frappe. */
  function windupThenHit(species: string, boss = false, weapon = 'sword'): {
    staggered: boolean
    monster: Actor
    state: GameState
  } {
    const s = createGame(4242)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_int', 'Interrupteur')
    hero.invulnUntil = 0
    hero.weapon = weapon
    const m = putMonster(s, 'm_wind', species, hero.x + 1.0, hero.y)
    m.hp = 9999
    if (boss) m.boss = true

    // On laisse la préparation démarrer sans frapper.
    let started = false
    for (let i = 0; i < TICK_RATE * 3 && !started; i++) {
      step(s, { p_int: idle })
      started = m.windupUntil !== undefined && s.tick < m.windupUntil
    }

    const hit: PlayerInput = { mx: 0, my: 0, aim: 0, attack: true, sprint: false }
    step(s, { p_int: hit })
    const staggered = s.events.some((e) => e.t === 'stagger' && e.id === m.id)
    return { staggered, monster: m, state: s }
  }

  const normal = windupThenHit('skeleton')
  check('frapper une préparation la fait manquer', normal.staggered)
  check(
    'et le monstre ne relance pas dans la foulée',
    normal.monster.windupUntil === undefined && normal.monster.readyAt > normal.state.tick,
  )
  check(
    'il devient insensible un moment',
    (normal.monster.staggerReadyAt ?? 0) > normal.state.tick,
  )

  const boss = windupThenHit('skeleton', true)
  check('un boss ne s\'interrompt pas', !boss.staggered)

  // Le garde-fou qui manquait : sans lui, on fonçait à la dague sur n'importe
  // quel monstre, on coupait son premier coup et on le tuait pendant qu'il se
  // remettait. Chaque tête-à-tête devenait gratuit.
  check(
    'une dague ne bouscule personne',
    !windupThenHit('skeleton', false, 'dagger').staggered,
  )
  check('un arc non plus', !windupThenHit('skeleton', false, 'bow').staggered)
  check('une hache, oui', windupThenHit('skeleton', false, 'axe').staggered)

  // Et même avec une arme qui pèse, l'interruption ne doit pas offrir de coup
  // supplémentaire : elle évite d'encaisser, c'est déjà la récompense.
  check(
    'interrompre n\'offre pas une frappe de plus',
    STAGGER_RECOVER < WEAPONS.sword!.cooldown,
    `${STAGGER_RECOVER} ticks de flottement contre ${WEAPONS.sword!.cooldown} de cadence`,
  )

  // L'immunité empêche le verrou : sur la durée, le monstre place ses coups.
  {
    const s = createGame(4343)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_lock2', 'Verrou')
    hero.invulnUntil = 0
    hero.maxHp = 9000
    hero.hp = 9000
    const m = putMonster(s, 'm_lock2', 'skeleton', hero.x + 1.0, hero.y)
    m.hp = 999999
    const spam: PlayerInput = { mx: 0, my: 0, aim: 0, attack: true, sprint: false }
    const before = hero.hp
    for (let i = 0; i < TICK_RATE * 12; i++) step(s, { p_lock2: spam })
    check(
      'marteler ne verrouille pas un monstre indéfiniment',
      hero.hp < before,
      `${before} -> ${hero.hp} PV en 12 s`,
    )
  }
}

// --- Économie de la descente ---------------------------------------------------
//
// La barre de vie doit être une ressource de descente, pas un stock qu'on
// rappelle entre deux escaliers. Trois chemins la rechargeaient gratuitement,
// dont deux écrits en dur et introuvables par recherche.
{
  console.log('\nUsure')

  check(
    'le plafond de soin descend avec l\'étage',
    healCap(1) === 1 && healCap(5) < healCap(1) && healCap(10) < healCap(5),
    `étage 1 ${(healCap(1) * 100).toFixed(0)} % · 5 ${(healCap(5) * 100).toFixed(0)} % · ` +
      `10 ${(healCap(10) * 100).toFixed(0)} % · 20 ${(healCap(20) * 100).toFixed(0)} %`,
  )
  check(
    'mais il ne descend pas indéfiniment',
    healCap(100) === HEAL_CAP_MIN,
    `${(healCap(100) * 100).toFixed(0)} % au plancher`,
  )

  // L'invariant qui compte : se faire relever doit toujours payer plus que
  // mourir, et mourir plus que se faire descendre à terre. Il était inversé.
  {
    let holds = true
    for (let floor = 1; floor <= 30; floor++) {
      const cap = healCap(floor)
      if (!(cap * REVIVE_OF_CAP > cap * RESPAWN_OF_CAP && cap * RESPAWN_OF_CAP > cap * CARRIED_OF_CAP)) {
        holds = false
      }
    }
    check(
      'relever paie plus que mourir, qui paie plus que se faire porter',
      holds && REVIVE_OF_CAP > RESPAWN_OF_CAP && RESPAWN_OF_CAP > CARRIED_OF_CAP,
      `${REVIVE_OF_CAP} > ${RESPAWN_OF_CAP} > ${CARRIED_OF_CAP} du plafond`,
    )
  }

  /** PV d'un héros après avoir ramassé autant de cœurs qu'il en faut. */
  function healToCeiling(floor: number): { hp: number; maxHp: number } {
    const s = createGame(555)
    clearMonsters(s)
    s.floor = floor
    const hero = addPlayer(s, 'p_heal', 'Blessé')
    hero.hp = 1
    for (let i = 0; i < 40; i++) {
      s.items.push({ id: `h${i}`, kind: 'heart', x: hero.x, y: hero.y })
      step(s, { p_heal: idle })
    }
    return { hp: hero.hp, maxHp: hero.maxHp }
  }

  const shallow = healToCeiling(1)
  check(
    'à l\'étage 1 les cœurs refont toute la barre',
    shallow.hp === shallow.maxHp,
    `${shallow.hp}/${shallow.maxHp}`,
  )
  const deep = healToCeiling(12)
  const deepRatio = deep.hp / deep.maxHp
  check(
    'en profondeur ils ne la refont plus',
    deepRatio < 0.95 && Math.abs(deepRatio - healCap(12)) < 0.03,
    `${deep.hp}/${deep.maxHp} = ${(deepRatio * 100).toFixed(0)} % pour un plafond à ` +
      `${(healCap(12) * 100).toFixed(0)} %`,
  )

  // Le trou le moins visible des trois : se laisser mettre à terre juste avant
  // l'escalier soignait à 50 % sans payer les huit secondes ni le saignement.
  {
    const s = createGame(556)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_carry', 'Porté')
    hero.hp = Math.round(hero.maxHp * 0.5)
    const before = hero.hp
    hero.downed = true
    hero.hp = 0
    descend(s)
    check(
      'se faire porter à terre ne soigne pas',
      hero.hp < before,
      `${before} -> ${hero.hp} PV`,
    )
  }
}

// --- Cohésion des vagues ------------------------------------------------------
//
// Une vague de six qui arrive un par un, c'est six tête-à-tête, et un
// tête-à-tête ne coûte rien. On vérifie que le groupe se resserre pendant
// l'approche, et surtout que la patience a une fin.
{
  console.log('\nCohésion')

  /** Un couloir dégagé, un héros immobile, deux monstres de la même escouade. */
  function approach(patience: number): { gapStart: number; gapEnd: number; lead: number } {
    const s = createGame(4242)
    clearMonsters(s)
    const hero = addPlayer(s, 'p_sq', 'Appât')
    hero.invulnUntil = 999999
    const row = Math.floor(hero.y)
    for (let x = 1; x < MAP_W - 1; x++) {
      for (let d = -2; d <= 2; d++) s.tiles[(row + d) * MAP_W + x] = Tile.Floor
    }

    const vanguard = putMonster(s, 'm_van', 'orc', hero.x + 10, hero.y)
    const laggard = putMonster(s, 'm_lag', 'orc', hero.x + 20, hero.y)
    for (const m of [vanguard, laggard]) {
      m.hp = 99999
      m.squad = 'sq'
      m.squadUntil = s.tick + patience
    }
    const gapStart = laggard.x - vanguard.x
    for (let i = 0; i < TICK_RATE * 8; i++) step(s, { p_sq: idle })
    return { gapStart, gapEnd: laggard.x - vanguard.x, lead: vanguard.x - hero.x }
  }

  const together = approach(TICK_RATE * 60)
  check(
    'l\'avant-garde attend les siens',
    together.gapEnd < together.gapStart * 0.6,
    `écart ${together.gapStart.toFixed(1)} -> ${together.gapEnd.toFixed(1)} tuiles`,
  )

  // La patience a une fin : sans elle, un seul membre incapable de rattraper
  // son retard immobiliserait la vague entière pour le reste de l'étage.
  const dissolved = approach(1)
  check(
    'et l\'escouade finit par se dissoudre',
    dissolved.lead < 2 && dissolved.gapEnd > together.gapEnd * 1.5,
    `avant-garde à ${dissolved.lead.toFixed(1)} tuile(s) du héros, ` +
      `écart ${dissolved.gapEnd.toFixed(1)}`,
  )

  // Le champ de flux doit porter jusqu'à la distance de livraison, sinon les
  // monstres livrés n'ont aucune direction et errent : c'était la vraie cause
  // des vagues qui se défaisaient.
  check(
    'le champ de flux porte plus loin que la livraison',
    FLOW_MAX_DIST > HORDE_MAX_DIST * 3,
    `${FLOW_MAX_DIST} contre ${HORDE_MAX_DIST} tuiles de livraison`,
  )
}

// --- Lecture du terrain -------------------------------------------------------
//
// La mesure vit côté serveur, mais c'est un classement facile à écrire à
// l'envers et personne ne s'en apercevrait dans un rapport : on le vérifie sur
// des cartes dessinées à la main plutôt que sur un donjon tiré au sort.
{
  console.log('\nTerrain')

  /** Une carte pleine de murs, dans laquelle on creuse à la demande. */
  function blank(): GameState {
    const s = createGame(1234)
    clearMonsters(s)
    s.tiles.fill(Tile.Wall)
    return s
  }

  const tunnel = blank()
  for (let x = 4; x < 30; x++) tunnel.tiles[10 * MAP_W + x] = Tile.Floor
  check('un boyau d\'une case est un couloir', terrainAt(tunnel, 12.5, 10.5) === 'couloir')

  const small = blank()
  for (let y = 8; y < 12; y++) {
    for (let x = 8; x < 12; x++) small.tiles[y * MAP_W + x] = Tile.Floor
  }
  check('une salle de 4×4 est une petite salle', terrainAt(small, 9.5, 9.5) === 'petite')

  const hall = blank()
  for (let y = 6; y < 18; y++) {
    for (let x = 6; x < 18; x++) hall.tiles[y * MAP_W + x] = Tile.Floor
  }
  check('une salle de 12×12 est une grande salle', terrainAt(hall, 11.5, 11.5) === 'grande')
  // Le coin d'une grande salle reste une grande salle : c'est la largeur
  // disponible qui compte, pas la distance au mur le plus proche.
  check('et son coin aussi', terrainAt(hall, 6.5, 6.5) === 'grande')
}

{
  console.log('\nActes et biomes')

  // Les clones portent l'équilibrage de leur original : si un seul chiffre
  // diverge, le TTK/K du biome n'est plus celui qu'on a validé.
  const pairs: [string, string][] = [
    ['soldat', 'orc'],
    ['archer_royal', 'skeleton_mage'],
    ['pretre', 'orc_mage'],
    ['chevalier', 'orc_warrior'],
  ]
  const statKeys = [
    'behavior', 'maxHp', 'atk', 'speed', 'reach', 'windup', 'cooldown',
    'knockback', 'weight', 'xp', 'projectileSpeed', 'keepAway',
    'dashSpeed', 'dashTicks', 'blastRadius',
  ] as const
  for (const [clone, base] of pairs) {
    const c = MONSTERS[clone]! as unknown as Record<string, unknown>
    const b = MONSTERS[base]! as unknown as Record<string, unknown>
    const same = statKeys.every((k) => c[k] === b[k])
    check(`${clone} est un clone strict de ${base}`, same)
  }

  check(
    'les étages 1-5 sont le Château, le 6 retombe au cachot',
    biomeOf(1).id === 'chateau' && biomeOf(5).id === 'chateau' && biomeOf(6).id === 'cachot',
  )
  check(
    "floorInAct compte de 1 à 5 dans l'acte",
    floorInAct(1) === 1 && floorInAct(5) === 5 && floorInAct(6) === 1 && floorInAct(11) === 1,
  )

  // La garnison monte d'un archétype par étage : ce qui apparaît à l'étage n
  // doit venir du pool de l'étage n, rien d'autre.
  const garnison = (floor: number, allowed: string[]): boolean => {
    const s = createGame(31415, floor)
    return Object.values(s.actors)
      .filter((a) => a.kind === 'monster')
      .every((a) => allowed.includes(a.species))
  }
  check('étages 1-2 : soldats et chauves-souris seulement', garnison(1, ['bat', 'soldat']) && garnison(2, ['bat', 'soldat']))
  check('étage 3 : les archers royaux rejoignent', garnison(3, ['bat', 'soldat', 'archer_royal']))
  check(
    'étage 4 : les chevaliers, mais pas encore les prêtres',
    garnison(4, ['bat', 'soldat', 'archer_royal', 'chevalier']),
  )
  check(
    'étage 5 : la garnison complète',
    garnison(5, ['bat', 'soldat', 'archer_royal', 'chevalier', 'pretre']),
  )

  // L'élite vient des rangs déjà connus : le nouveau venu d'un étage sert dans
  // la troupe avant de porter la clé — pas de pic que rien n'annonce.
  const keeperOf = (floor: number, seed: number) =>
    Object.values(createGame(seed, floor).actors).find((a) => a.elite)?.species
  const keepersOk = [111, 222, 333, 444, 555].every((seed) => {
    const k3 = keeperOf(3, seed)
    const k4 = keeperOf(4, seed)
    return k3 === 'soldat' && (k4 === 'soldat' || k4 === 'archer_royal')
  })
  check("le gardien d'élite est toujours un vétéran de l'acte", keepersOk)

  const g5 = createGame(31415, 5)
  const boss5 = Object.values(g5.actors).find((a) => a.boss)
  check(
    "l'étage 5 est gardé par le Chevalier colossal",
    boss5?.species === 'chevalier' && boss5.name === 'Chevalier colossal',
  )
  const g10 = createGame(31415, 10)
  const boss10 = Object.values(g10.actors).find((a) => a.boss)
  check("l'étage 10 garde son boss du cachot", boss10?.species === 'orc_warrior')
}

{
  console.log('\nSAS marchand')

  const inRoom = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

  const s = createGame(2718, 5)
  const survivors = Object.values(s.actors).filter((a) => a.kind === 'monster' && a.alive)
  check("il reste des monstres vivants à l'étage 5 avant la descente", survivors.length > 0)
  descend(s)

  const sasRoom = s.rooms[0]!
  check("l'étage 6 s'ouvre sur un SAS — la salle d'arrivée est un repos", sasRoom.kind === 'repos')
  check('la porte de l\'acte purge les poursuivants', s.pursuers.length === 0)
  check(
    'une seule salle de repos : le SAS remplace le repos organique',
    s.rooms.filter((r) => r.kind === 'repos').length === 1,
  )

  const sasItems = s.items.filter((i) => inRoom(sasRoom, i.x, i.y))
  const kinds = new Set(sasItems.map((i) => i.kind))
  check(
    "l'étal complet et un coffre attendent dans le SAS",
    kinds.has('cap') && kinds.has('soin') && kinds.has('fiole_souffle') &&
      kinds.has('fiole_vitesse') && kinds.has('chest'),
  )
  const sx = s.spawn.x + 0.5
  const sy = s.spawn.y + 0.5
  const nearest = Math.min(...sasItems.map((i) => Math.hypot(i.x - sx, i.y - sy)))
  check(
    "rien ne s'achète en arrivant — aucun article à portée du spawn",
    nearest > 0.75 + 0.2,
    `plus proche à ${nearest.toFixed(2)} tuile(s)`,
  )

  check(
    'aucun monstre dans le SAS',
    !Object.values(s.actors).some(
      (a) => a.kind === 'monster' && a.alive && inRoom(sasRoom, a.x, a.y),
    ),
  )
  const keeper = Object.values(s.actors).find((a) => a.elite || a.boss)
  check(
    "l'étage reste un étage : gardien vivant ailleurs, escalier verrouillé",
    keeper !== undefined && keeper.alive && !inRoom(sasRoom, keeper.x, keeper.y) && s.stairsLocked,
  )
  check(
    'le marchand tient son étal dans le SAS',
    s.decor.some((d) => d.kind === 'marchand' && inRoom(sasRoom, d.x, d.y)),
  )

  // Étage ordinaire : la dette suit toujours.
  const t = createGame(2718, 6)
  descend(t)
  check('hors SAS, ce qu\'on n\'a pas tué nous suit encore', t.pursuers.length > 0)
  check("l'étage 7 n'a pas de SAS", t.rooms[0]!.kind !== 'repos')

  // Même graine, même SAS : la descente reste déterministe.
  const a = createGame(2718, 5)
  const b = createGame(2718, 5)
  descend(a)
  descend(b)
  const fingerprint = (g: GameState) =>
    JSON.stringify([
      g.items.map((i) => [i.kind, i.x, i.y]),
      Object.values(g.actors).filter((x) => x.kind === 'monster').map((m) => [m.species, m.x, m.y]),
    ])
  check('même graine, même SAS — déterminisme intact', fingerprint(a) === fingerprint(b))
}

console.log(`\n${failures === 0 ? 'Tout est vert.' : `${failures} test(s) en échec.`}\n`)
process.exit(failures === 0 ? 0 : 1)
