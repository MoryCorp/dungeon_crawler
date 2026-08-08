/**
 * Génération d'étage par BSP : on découpe récursivement la carte en zones,
 * chaque feuille devient une salle, et on relie les frères par des couloirs en L.
 *
 * Entièrement déterministe à partir du Rng passé en argument.
 */
import type { Rng } from './rng.js'
import { MAP_H, MAP_W, Tile } from './types.js'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface FloorLayout {
  width: number
  height: number
  tiles: Uint8Array
  rooms: Rect[]
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

function bsp(
  rng: Rng,
  area: Rect,
  depth: number,
  tiles: Uint8Array,
  w: number,
  rooms: Rect[],
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

  const room: Rect = { x: rx, y: ry, w: rw, h: rh }
  carveRect(tiles, w, room)
  rooms.push(room)
  return center(room)
}

export function generateFloor(rng: Rng, floor: number): FloorLayout {
  const width = MAP_W
  const height = MAP_H
  const tiles = new Uint8Array(width * height).fill(Tile.Wall)
  const rooms: Rect[] = []

  bsp(rng, { x: 1, y: 1, w: width - 2, h: height - 2 }, 0, tiles, width, rooms)

  // Sécurité : une carte sans salle est injouable. Ne devrait pas arriver avec
  // les dimensions actuelles, mais on ne veut pas d'un crash serveur pour ça.
  if (rooms.length === 0) {
    const fallback: Rect = { x: 2, y: 2, w: 10, h: 10 }
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

  return {
    width,
    height,
    tiles,
    rooms,
    spawn: { x: sx, y: sy },
    stairs: { x: stx, y: sty },
  }
}
