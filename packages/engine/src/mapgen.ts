/**
 * Génération d'étage par BSP : on découpe récursivement la carte en zones,
 * chaque feuille devient une salle, et on relie les frères par des couloirs en L.
 *
 * Entièrement déterministe à partir du Rng passé en argument.
 */
import { Rng } from './rng.js'
import { MAP_H, MAP_W, Tile } from './types.js'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Type d'une salle — décidé par sa forme, pas par un tirage : une salle longue
 * EST une galerie, la typer autrement serait un mensonge que le joueur voit.
 *
 * - arène : grande et ouverte, tout y est jouable ;
 * - galerie : longue, des lignes de vue — le terrain des tireurs ;
 * - piliers : grande mais encombrée d'obstacles — les charges y ratent,
 *   les projectiles s'y bloquent, la mêlée y tourne autour des blocs ;
 * - trésor : la salle piégée, une récompense visible et une grille (au plus
 *   une par étage, jamais celle du spawn ni de l'escalier) ;
 * - standard : le reste.
 */
export type RoomKind = 'standard' | 'arene' | 'galerie' | 'piliers' | 'tresor' | 'repos'

export interface Room extends Rect {
  kind: RoomKind
}

/**
 * Décor : purement visuel, jamais solide, jamais ramassable.
 *
 * Il existe pour une seule raison — se repérer. Toutes les salles d'un donjon
 * généré se ressemblent, et un joueur qui revient sur ses pas ne le sait pas.
 * Chaque salle reçoit donc sa signature : un motif dominant, en deux ou trois
 * exemplaires, tiré de la graine de l'étage. « La salle aux champignons »
 * devient un lieu, et non un rectangle de plus.
 */
export type DecorKind = 'pot' | 'caillou' | 'os' | 'champignon' | 'colonne' | 'caisse' | 'marchand'

/**
 * Les motifs que le scatter tire au sort. Le marchand n'y figure pas : il est
 * posé explicitement par descend() dans le SAS d'entrée d'acte, jamais tiré.
 */
export const DECOR_KINDS: readonly DecorKind[] = [
  'pot', 'caillou', 'os', 'champignon', 'colonne', 'caisse',
]

export interface Decor {
  x: number
  y: number
  kind: DecorKind
}

export interface FloorLayout {
  width: number
  height: number
  tiles: Uint8Array
  rooms: Room[]
  decor: Decor[]
  spawn: { x: number; y: number }
  stairs: { x: number; y: number }
}

const MIN_ROOM = 6
const MAX_DEPTH = 4

const center = (r: Rect): [number, number] => [
  r.x + Math.floor(r.w / 2),
  r.y + Math.floor(r.h / 2),
]

function carveRect(tiles: Uint8Array, w: number, r: Rect): void {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      tiles[y * w + x] = Tile.Floor
    }
  }
}

function carveCorridor(
  tiles: Uint8Array,
  w: number,
  a: [number, number],
  b: [number, number],
  rng: Rng,
): void {
  const [ax, ay] = a
  const [bx, by] = b
  // Couloir en L : on tire au sort si on part horizontalement ou verticalement.
  const horizontalFirst = rng.chance(0.5)
  const corner: [number, number] = horizontalFirst ? [bx, ay] : [ax, by]

  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const sx = Math.sign(x1 - x0)
    const sy = Math.sign(y1 - y0)
    let x = x0
    let y = y0
    for (;;) {
      if (tiles[y * w + x] === Tile.Wall) tiles[y * w + x] = Tile.Floor
      if (x === x1 && y === y1) break
      if (x !== x1) x += sx
      else if (y !== y1) y += sy
    }
  }

  line(ax, ay, corner[0], corner[1])
  line(corner[0], corner[1], bx, by)
}

/**
 * Piliers : des blocs de mur en quinconce dans la salle, à deux tuiles d'écart
 * — assez pour circuler partout, assez serré pour casser les lignes de charge
 * et les tirs tendus. La marge de 2 avec les murs garantit qu'aucun couloir
 * débouchant ne peut être bouché par un pilier.
 */
function carvePillars(tiles: Uint8Array, w: number, room: Rect): void {
  const [cx, cy] = center(room)
  for (let py = room.y + 2; py < room.y + room.h - 2; py += 3) {
    for (let px = room.x + 2; px < room.x + room.w - 2; px += 3) {
      // Le centre reste libre : c'est là que se posent le spawn, l'escalier
      // et les extrémités de couloir.
      if (px === cx && py === cy) continue
      tiles[py * w + px] = Tile.Wall
    }
  }
}

/** Le type que la forme impose. Les piliers se décident (et se creusent) après. */
function kindOf(room: Rect, rng: Rng): RoomKind {
  const long = Math.max(room.w, room.h)
  const short = Math.min(room.w, room.h)
  if (long >= 10 && long >= short * 2.2) return 'galerie'
  if (room.w >= 9 && room.h >= 9) return rng.chance(0.5) ? 'arene' : 'piliers'
  return 'standard'
}

function bsp(
  rng: Rng,
  area: Rect,
  depth: number,
  tiles: Uint8Array,
  w: number,
  rooms: Room[],
): [number, number] {
  const canSplitV = area.w >= MIN_ROOM * 2 + 2
  const canSplitH = area.h >= MIN_ROOM * 2 + 2

  if (depth < MAX_DEPTH && (canSplitV || canSplitH)) {
    // On coupe préférentiellement dans la plus grande dimension, pour éviter
    // les zones en lanière.
    const vertical = canSplitV && (!canSplitH || rng.chance(area.w / (area.w + area.h)))

    let a: [number, number]
    let b: [number, number]
    if (vertical) {
      const cut = rng.range(MIN_ROOM, area.w - MIN_ROOM)
      a = bsp(rng, { x: area.x, y: area.y, w: cut, h: area.h }, depth + 1, tiles, w, rooms)
      b = bsp(
        rng,
        { x: area.x + cut, y: area.y, w: area.w - cut, h: area.h },
        depth + 1,
        tiles,
        w,
        rooms,
      )
    } else {
      const cut = rng.range(MIN_ROOM, area.h - MIN_ROOM)
      a = bsp(rng, { x: area.x, y: area.y, w: area.w, h: cut }, depth + 1, tiles, w, rooms)
      b = bsp(
        rng,
        { x: area.x, y: area.y + cut, w: area.w, h: area.h - cut },
        depth + 1,
        tiles,
        w,
        rooms,
      )
    }

    carveCorridor(tiles, w, a, b, rng)
    return rng.chance(0.5) ? a : b
  }

  // Feuille : on creuse une salle à l'intérieur de la zone, avec une marge de 1
  // pour garantir un mur entre deux salles adjacentes.
  const maxW = Math.max(4, area.w - 2)
  const maxH = Math.max(4, area.h - 2)
  const rw = rng.range(Math.min(4, maxW), maxW)
  const rh = rng.range(Math.min(4, maxH), maxH)
  const rx = area.x + 1 + rng.int(Math.max(1, area.w - rw - 1))
  const ry = area.y + 1 + rng.int(Math.max(1, area.h - rh - 1))

  const room: Room = { x: rx, y: ry, w: rw, h: rh, kind: 'standard' }
  carveRect(tiles, w, room)
  room.kind = kindOf(room, rng)
  if (room.kind === 'piliers') carvePillars(tiles, w, room)
  rooms.push(room)
  return center(room)
}

export function generateFloor(rng: Rng, floor: number): FloorLayout {
  const width = MAP_W
  const height = MAP_H
  const tiles = new Uint8Array(width * height).fill(Tile.Wall)
  const rooms: Room[] = []

  bsp(rng, { x: 1, y: 1, w: width - 2, h: height - 2 }, 0, tiles, width, rooms)

  // Sécurité : une carte sans salle est injouable. Ne devrait pas arriver avec
  // les dimensions actuelles, mais on ne veut pas d'un crash serveur pour ça.
  if (rooms.length === 0) {
    const fallback: Room = { x: 2, y: 2, w: 10, h: 10, kind: 'standard' }
    carveRect(tiles, width, fallback)
    rooms.push(fallback)
  }

  const spawnRoom = rooms[0]!
  const [sx, sy] = center(spawnRoom)

  // L'escalier va dans la salle la plus éloignée du spawn, pour forcer
  // l'exploration plutôt que la sortie immédiate.
  let stairsRoom = rooms[rooms.length - 1]!
  let best = -1
  for (const r of rooms) {
    const [cx, cy] = center(r)
    const d = Math.abs(cx - sx) + Math.abs(cy - sy)
    if (d > best) {
      best = d
      stairsRoom = r
    }
  }
  const [stx, sty] = center(stairsRoom)
  tiles[sty * width + stx] = Tile.Stairs

  // La salle piégée : une par étage à partir du 3, petite — le pari doit se
  // lire d'un coup d'œil depuis la porte, pas se découvrir au fond d'une
  // arène. Jamais la salle du spawn ni celle de l'escalier : on ne piège ni
  // l'arrivée ni l'objectif.
  if (floor >= 3) {
    const candidates = rooms.filter(
      (r) =>
        r !== spawnRoom &&
        r !== stairsRoom &&
        r.kind !== 'piliers' && // la grille + les blocs = un combat illisible
        r.w >= 5 && r.h >= 5 && r.w <= 9 && r.h <= 9,
    )
    if (candidates.length > 0) {
      candidates[rng.int(candidates.length)]!.kind = 'tresor'
    }
  }

  return {
    width,
    height,
    tiles,
    rooms,
    decor: scatterDecor(tiles, width, rooms, floor, sx, sy, stx, sty),
    spawn: { x: sx, y: sy },
    stairs: { x: stx, y: sty },
  }
}

/**
 * Sème la signature de chaque salle. Une salle = un motif dominant en
 * plusieurs exemplaires : c'est la répétition qui fait le repère, pas la
 * variété. Les bords sont évités (on longe les murs en combat) ainsi que le
 * spawn et l'escalier, qui ont déjà leur propre lecture.
 */
function scatterDecor(
  tiles: Uint8Array,
  w: number,
  rooms: Room[],
  floor: number,
  sx: number,
  sy: number,
  stx: number,
  sty: number,
): Decor[] {
  // Tirage à part, dérivé de la géométrie déjà produite plutôt que du flux
  // principal : puiser dans le RNG de la partie décalerait le placement des
  // monstres, et une graine donnée ne rejouerait plus le même donjon qu'avant.
  // Un ornement ne doit rien pouvoir changer au jeu.
  const rng = new Rng(
    (Math.imul(floor, 2654435761) ^
      Math.imul(rooms.length, 40503) ^
      Math.imul(sx * 64 + sy, 73856093) ^
      Math.imul(stx * 64 + sty, 19349663)) >>> 0,
  )
  const out: Decor[] = []
  const taken = new Set<number>([sy * w + sx, sty * w + stx])
  for (const room of rooms) {
    const kind = DECOR_KINDS[rng.int(DECOR_KINDS.length)]!
    // Assez pour former un motif, jamais au point d'encombrer la lecture du
    // combat : une grande salle en reçoit quatre, une petite deux.
    const count = Math.min(4, 2 + Math.floor((room.w * room.h) / 60))
    for (let i = 0; i < count; i++) {
      // Quelques essais suffisent : rater une pose n'a aucune conséquence.
      for (let attempt = 0; attempt < 8; attempt++) {
        const x = room.x + 1 + rng.int(Math.max(1, room.w - 2))
        const y = room.y + 1 + rng.int(Math.max(1, room.h - 2))
        const idx = y * w + x
        if (taken.has(idx) || tiles[idx] !== Tile.Floor) continue
        taken.add(idx)
        out.push({ x, y, kind })
        break
      }
    }
  }
  return out
}
