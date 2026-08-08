/**
 * Tests de l'engine pur — aucun serveur, aucun réseau, aucun navigateur.
 *
 *   npx tsx scripts/engine-test.ts
 */
import {
  ACTOR_RADIUS,
  ATTACK_HALF_ARC,
  ATTACK_REACH,
  FOV_RADIUS,
  MAP_H,
  MAP_W,
  MONSTERS,
  MONSTER_HALF_ARC,
  PLAYER_SPEED,
  Rng,
  TICK_RATE,
  Tile,
  addPlayer,
  computeFov,
  createGame,
  generateFloor,
  inAttackArc,
  isWalkable,
  movePhysical,
  packBits,
  step,
  unpackBits,
  type GameState,
  type PlayerInput,
} from '@dc/engine'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const idle: PlayerInput = { mx: 0, my: 0, aim: 0, attack: false }
const noInputs: Record<string, PlayerInput | null> = {}

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
    ATTACK_HALF_ARC, ATTACK_REACH,
    10.7, 10.7, ACTOR_RADIUS,
  )
  check('un ennemi en diagonale est touché quand on le vise', hitDiagonal)

  // Et même en visant franchement à l'est, une cible en diagonale au contact
  // reste dans l'arc, parce qu'elle occupe un large secteur de près.
  const hitSloppy = inAttackArc(
    10, 10, 0,
    ATTACK_HALF_ARC, ATTACK_REACH,
    10.6, 10.6, ACTOR_RADIUS,
  )
  check('viser approximativement suffit au contact', hitSloppy)

  const missBehind = inAttackArc(
    10, 10, 0,
    ATTACK_HALF_ARC, ATTACK_REACH,
    8.9, 10, ACTOR_RADIUS,
  )
  check('on ne touche pas dans le dos', !missBehind)

  const missFar = inAttackArc(
    10, 10, 0,
    ATTACK_HALF_ARC, ATTACK_REACH,
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

// --- respawn ---------------------------------------------------------------
{
  const s = createGame(2024)
  const hero = addPlayer(s, 'p_dead', 'Mort')
  hero.hp = 1
  hero.invulnUntil = 0
  const monster = Object.values(s.actors).find((a) => a.kind === 'monster')!
  monster.x = hero.x + 0.5
  monster.y = hero.y
  monster.aggroUntil = 999999

  let died = false
  for (let i = 0; i < TICK_RATE * 10 && !died; i++) {
    step(s, noInputs)
    died = !s.actors['p_dead']!.alive
  }
  check('un héros à 1 PV finit par tomber', died)

  for (const a of Object.values(s.actors)) {
    if (a.kind === 'monster') delete s.actors[a.id]
  }
  for (let i = 0; i < TICK_RATE * 12; i++) step(s, noInputs)
  check('le héros réapparaît tout seul', s.actors['p_dead']!.alive)
  check('il est invulnérable un instant après le respawn', (s.actors['p_dead']!.invulnUntil ?? 0) > 0)
}

console.log(`\n${failures === 0 ? 'Tout est vert.' : `${failures} test(s) en échec.`}\n`)
process.exit(failures === 0 ? 0 : 1)
