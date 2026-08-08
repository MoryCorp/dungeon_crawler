/**
 * Tests de l'engine pur — aucun serveur, aucun réseau, aucun navigateur.
 *
 *   npx tsx scripts/engine-test.ts
 *
 * C'est le gros avantage d'avoir sorti les règles dans un paquet sans
 * dépendances : elles se testent en quelques millisecondes.
 */
import {
  FOV_RADIUS,
  MAP_H,
  MAP_W,
  Rng,
  Tile,
  addPlayer,
  computeFov,
  createGame,
  generateFloor,
  isWalkable,
  packBits,
  step,
  unpackBits,
  type GameState,
  type Intent,
} from '@dc/engine'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
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
    `${floors} cases praticables sur ${MAP_W * MAP_H}`,
  )
  check('le spawn est praticable', isWalkable(layout.tiles[layout.spawn.y * MAP_W + layout.spawn.x]!))
  check('l\'escalier est posé', layout.tiles[layout.stairs.y * MAP_W + layout.stairs.x] === Tile.Stairs)

  // Toutes les salles doivent être joignables depuis le spawn, sinon un étage
  // peut être infranchissable.
  const seen = new Uint8Array(MAP_W * MAP_H)
  const queue = [layout.spawn.y * MAP_W + layout.spawn.x]
  seen[queue[0]!] = 1
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]!
    const x = idx % MAP_W
    const y = (idx / MAP_W) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx!
      const ny = y + dy!
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue
      const ni = ny * MAP_W + nx
      if (seen[ni] || !isWalkable(layout.tiles[ni]!)) continue
      seen[ni] = 1
      queue.push(ni)
    }
  }
  const unreachable = layout.rooms.filter((r) => {
    const cx = r.x + Math.floor(r.w / 2)
    const cy = r.y + Math.floor(r.h / 2)
    return !seen[cy * MAP_W + cx]
  })
  check('toutes les salles sont accessibles depuis le spawn', unreachable.length === 0, `${unreachable.length} isolées`)
  check('l\'escalier est accessible', Boolean(seen[layout.stairs.y * MAP_W + layout.stairs.x]))
}

// --- déterminisme ----------------------------------------------------------
{
  const a = createGame(999)
  const b = createGame(999)
  const noIntents: Record<string, Intent | null> = {}
  for (let i = 0; i < 300; i++) {
    step(a, noIntents)
    step(b, noIntents)
  }
  const fingerprint = (s: GameState) =>
    JSON.stringify(
      Object.values(s.actors)
        .map((m) => `${m.id}:${m.x},${m.y},${m.hp}`)
        .sort(),
    )
  check('même graine = même partie après 300 ticks', fingerprint(a) === fingerprint(b))
  check('les monstres sont peuplés', Object.keys(a.actors).length > 0, `${Object.keys(a.actors).length} acteurs`)
}

// --- les monstres vivent leur vie hors du champ de vision -------------------
{
  const s = createGame(4242)
  const positionsBefore = Object.values(s.actors).map((m) => `${m.x},${m.y}`).join('|')
  for (let i = 0; i < 100; i++) step(s, {})
  const positionsAfter = Object.values(s.actors).map((m) => `${m.x},${m.y}`).join('|')
  check('les monstres bougent même sans joueur connecté', positionsBefore !== positionsAfter)
}

// --- champ de vision -------------------------------------------------------
{
  const s = createGame(777)
  const vis = new Uint8Array(MAP_W * MAP_H)
  computeFov(s.tiles, MAP_W, MAP_H, s.spawn.x, s.spawn.y, FOV_RADIUS, vis)
  const count = vis.reduce((a, b) => a + b, 0)
  const maxDisc = Math.PI * FOV_RADIUS * FOV_RADIUS
  check('le champ de vision couvre une zone crédible', count > 10 && count <= maxDisc, `${count} cases`)
  check('on se voit soi-même', vis[s.spawn.y * MAP_W + s.spawn.x] === 1)

  const far = vis[(s.spawn.y + FOV_RADIUS + 3) * MAP_W + s.spawn.x]
  check('rien n\'est visible au-delà du rayon', far !== 1)
}

// --- bitset réseau ---------------------------------------------------------
{
  const src = new Uint8Array(MAP_W * MAP_H)
  for (let i = 0; i < src.length; i += 3) src[i] = 1
  const round = unpackBits(packBits(src), src.length)
  check('packBits/unpackBits est réversible', round.every((v, i) => v === src[i]))
  check('le bitset compresse bien', packBits(src).length === src.length / 8, `${packBits(src).length} octets pour ${src.length} cases`)
}

// --- combat et respawn -----------------------------------------------------
{
  const s = createGame(31337)
  const hero = addPlayer(s, 'p_test', 'Testeur')
  const before = hero.hp
  hero.hp = 3

  // On colle un monstre à côté du héros et on laisse tourner : il doit frapper.
  const monster = Object.values(s.actors).find((a) => a.kind === 'monster')!
  monster.x = hero.x + 1
  monster.y = hero.y
  monster.readyAt = s.tick

  let died = false
  for (let i = 0; i < 200 && !died; i++) {
    step(s, {})
    if (!s.actors['p_test']!.alive) died = true
  }
  check('un monstre adjacent finit par tuer un héros à 3 PV', died)
  check('le héros mort a une date de respawn', s.actors['p_test']!.respawnAt !== undefined)

  // On vide l'étage avant de tester le respawn : sinon le monstre resté sur
  // place retue le héros dans la foulée et on ne mesure plus rien.
  for (const a of Object.values(s.actors)) {
    if (a.kind === 'monster') delete s.actors[a.id]
  }
  for (let i = 0; i < 200; i++) step(s, {})
  check('le héros réapparaît tout seul', s.actors['p_test']!.alive)
  check('il réapparaît avec des PV', s.actors['p_test']!.hp > 0 && s.actors['p_test']!.hp <= before)
}

console.log(`\n${failures === 0 ? 'Tout est vert.' : `${failures} test(s) en échec.`}\n`)
process.exit(failures === 0 ? 0 : 1)
