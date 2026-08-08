/**
 * Affiche une sauvegarde de partie en ASCII : murs, portes, escalier, acteurs
 * et objets au sol. Debug uniquement.
 *
 *   npx tsx scripts/mapdump.ts data/rooms/ABCD.json
 *
 * Sert quand une position n'a pas de sens (personnage coincé, monstre
 * inatteignable) : la carte dit en une seconde ce qu'un dump JSON cache.
 */
import { readFileSync } from 'node:fs'
import { Tile, fromBase64, type Actor, type GameState, type GroundItem } from '@dc/engine'

const file = process.argv[2]
if (!file) {
  console.error('usage: npx tsx scripts/mapdump.ts <fichier de sauvegarde>')
  process.exit(1)
}

const saved = JSON.parse(readFileSync(file, 'utf8')) as { state: GameState & { tiles: string } }
const s = saved.state
const tiles = fromBase64(s.tiles)

const glyph = (t: number): string =>
  t === Tile.Wall ? '#' : t === Tile.Door ? '+' : t === Tile.Stairs ? '>' : '.'

const grid: string[][] = []
for (let y = 0; y < s.height; y++) {
  const row: string[] = []
  for (let x = 0; x < s.width; x++) row.push(glyph(tiles[y * s.width + x]!))
  grid.push(row)
}

// Les objets d'abord : un acteur posé dessus doit rester visible.
for (const item of s.items as GroundItem[]) {
  grid[Math.floor(item.y)]![Math.floor(item.x)] = item.kind === 'chest' ? 'C' : '*'
}
for (const a of Object.values(s.actors) as Actor[]) {
  grid[Math.floor(a.y)]![Math.floor(a.x)] =
    a.kind === 'player' ? '@' : a.boss ? 'B' : a.elite ? 'E' : 'm'
}

console.log(grid.map((r) => r.join('')).join('\n'))
console.log(
  `\nétage ${s.floor} · tick ${s.tick} · escalier ${s.stairsLocked ? 'verrouillé' : 'ouvert'}` +
    ` · spawn (${s.spawn.x},${s.spawn.y}) · escalier (${s.stairs.x},${s.stairs.y})`,
)
for (const a of Object.values(s.actors) as Actor[]) {
  const rank = a.boss ? ' [boss]' : a.elite ? ' [élite]' : ''
  const state = !a.alive ? ' mort' : a.downed ? ' à terre' : ''
  console.log(
    `  ${a.kind === 'player' ? '@' : '#'} ${a.name}${rank} ` +
      `(${a.x.toFixed(1)},${a.y.toFixed(1)}) ${a.hp}/${a.maxHp}${state}`,
  )
}
