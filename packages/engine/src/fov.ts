/**
 * Champ de vision par lancer de rayons (Bresenham).
 *
 * Approche volontairement naïve : pour chaque case dans le rayon, on trace une
 * ligne vers l'origine. À rayon 9 ça fait ~300 cases x ~9 pas = 2700 opérations
 * par joueur et par tick, soit ~160k/s à 4 joueurs. Négligeable, et le code
 * reste évident — le shadowcasting récursif sera un remplacement local si un
 * jour le profil le justifie.
 */
import { blocksSight } from './types.js'

/** Ligne de vue entre deux points, extrémités exclues du test de blocage. */
export function hasLineOfSight(
  tiles: Uint8Array,
  w: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0

  for (;;) {
    if (x === x1 && y === y1) return true
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
    if (x === x1 && y === y1) return true
    // Un mur intermédiaire bloque : la case du mur elle-même reste visible
    // (c'est l'extrémité), mais rien derrière.
    if (blocksSight(tiles[y * w + x]!)) return false
  }
}

/**
 * Marque à 1 dans `out` toutes les cases visibles depuis (ox, oy).
 * N'efface pas `out` : les appels successifs s'accumulent, ce qui donne
 * directement l'union des champs de vision de l'équipe.
 */
export function computeFov(
  tiles: Uint8Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  radius: number,
  out: Uint8Array,
): void {
  const r2 = radius * radius
  const minX = Math.max(0, ox - radius)
  const maxX = Math.min(w - 1, ox + radius)
  const minY = Math.max(0, oy - radius)
  const maxY = Math.min(h - 1, oy + radius)

  out[oy * w + ox] = 1

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - ox
      const dy = y - oy
      if (dx * dx + dy * dy > r2) continue
      if (out[y * w + x] === 1) continue // déjà vu par un coéquipier
      if (hasLineOfSight(tiles, w, ox, oy, x, y)) out[y * w + x] = 1
    }
  }
}
