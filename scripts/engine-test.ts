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
  HEART_HEAL_RATIO,
  MAP_H,
  MAP_W,
  MONSTERS,
  MONSTER_HALF_ARC,
  PLAYER_BASE_HP,
  PLAYER_SPEED,
  DIRECTOR_PATIENCE,
  DIRECTOR_REST,
  HORDE_MIN,
  PURSUE_MAX,
  createDirector,
  profileStats,
  planWave,
  resolveBehavior,
  splitShares,
  updateDirector,
  RECIPES,
  type Behavior,
  type RecipeName,
  REVIVE_TICKS,
  Rng,
  TARGET_TTK,
  TICK_RATE,
  Tile,
  WEAPONS,
  addPlayer,
  computeFov,
  createGame,
  descend,
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

const SWORD = WEAPONS.sword!

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const idle: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false }
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

  const spam: PlayerInput = { mx: 0, my: 0, aim: 0, attack: true }
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
  step(s2, { p_hit: { mx: 0, my: 0, aim: 0, attack: true } })
  const firstPush = Math.hypot(victim.kx, victim.ky)
  check('le premier coup projette franchement', firstPush > 3, `recul ${firstPush.toFixed(1)}`)

  // Le deuxième coup enchaîné doit pousser nettement moins.
  hero2.readyAt = s2.tick
  const before = Math.hypot(victim.kx, victim.ky)
  step(s2, { p_hit: { mx: 0, my: 0, aim: 0, attack: true } })
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
    const input: PlayerInput = { mx: dir, my: 0, aim: dir > 0 ? 0 : Math.PI, attack }
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

  const attackDiag: PlayerInput = { mx: 0, my: 0, aim: Math.atan2(0.7, 0.7), attack: true }
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
  const flee: PlayerInput = { mx: 0, my: -1, aim: 0, attack: false }
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
{
  const s = createGame(2024)
  const hero = addPlayer(s, 'p_dead', 'Mort')
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
  // Sans personne pour le relever, il finit par mourir pour de bon.
  for (let i = 0; i < BLEED_OUT_TICKS + 5; i++) step(s, noInputs)
  check('sans coéquipier, il finit par mourir', !s.actors['p_dead']!.alive)

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
  step(s, { p_reach: { mx: 0, my: 0, aim: 0, attack: true } })
  check('la dague ne touche pas à 2 tuiles', target.hp === 999)

  hero.weapon = 'spear'
  hero.readyAt = s.tick
  step(s, { p_reach: { mx: 0, my: 0, aim: 0, attack: true } })
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

  step(s, { p_bow: { mx: 0, my: 0, aim: 0, attack: true } })
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
  step(s, { p_loot: { mx: 0, my: 0, aim: 0, attack: true } })
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

// --- échange d'arme : pas de va-et-vient infini -----------------------------
{
  const s = createGame(2525)
  clearMonsters(s)
  const hero = addPlayer(s, 'p_swap', 'Échangeur')
  s.items.length = 0
  s.items.push({ id: 'i_axe', kind: 'weapon', x: hero.x, y: hero.y, weapon: 'axe' })

  step(s, noInputs)
  check('marcher sur une arme l\'équipe', hero.weapon === 'axe', String(hero.weapon))
  check('l\'ancienne arme reste au sol', s.items.some((i) => i.weapon === 'sword'))

  // En restant planté dessus, on ne doit pas réenchaîner les échanges.
  for (let i = 0; i < TICK_RATE * 3; i++) step(s, noInputs)
  check('rester sur l\'arme posée ne la reprend pas', hero.weapon === 'axe', String(hero.weapon))

  // En s'éloignant puis en revenant, si.
  hero.x += 4
  step(s, noInputs)
  hero.x -= 4
  for (let i = 0; i < 3; i++) step(s, noInputs)
  check('revenir sur son arme la reprend', hero.weapon === 'sword', String(hero.weapon))
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
      step(s, { p_key: { mx: 0, my: 0, aim: 0, attack: true } })
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
  step(s, { p_prof: { mx: 0, my: 0, aim: 0, attack: true } })
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
    step(moving, { p_move: { mx: Math.cos(angle), my: Math.sin(angle), aim: 0, attack: false } })
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
    const input: PlayerInput = { mx: 1, my: 0.3, aim: 1, attack: true }
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

console.log(`\n${failures === 0 ? 'Tout est vert.' : `${failures} test(s) en échec.`}\n`)
process.exit(failures === 0 ? 0 : 1)
