/**
 * IA des monstres, basée sur un champ de distance (Dijkstra map).
 *
 * On calcule une fois par tick la distance de chaque case au joueur le plus
 * proche, puis chaque monstre descend simplement le gradient. C'est la
 * technique classique des roguelikes : un seul BFS pour tous les monstres, un
 * comportement de groupe correct (ils se répartissent naturellement autour de
 * la cible) et aucun pathfinding par entité.
 */
import type { Rng } from './rng.js'
import type { Actor, Dir, GameState, Intent } from './types.js'
import { AGGRO_MAX_DIST, AGGRO_MEMORY, DIR_VEC, DIRS, isWalkable } from './types.js'

/** Remplit `out` avec la distance de chaque case au joueur vivant le plus proche (-1 = inatteignable). */
export function buildFlowField(state: GameState, out: Int16Array, maxDist: number): void {
  out.fill(-1)
  const w = state.width
  const h = state.height
  const queue: number[] = []

  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive) continue
    const idx = a.y * w + a.x
    if (out[idx] === -1) {
      out[idx] = 0
      queue.push(idx)
    }
  }

  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]!
    const d = out[idx]!
    if (d >= maxDist) continue
    const x = idx % w
    const y = (idx / w) | 0

    for (const dir of DIRS) {
      const [dx, dy] = DIR_VEC[dir]
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const ni = ny * w + nx
      if (out[ni] !== -1) continue
      if (!isWalkable(state.tiles[ni]!)) continue
      out[ni] = d + 1
      queue.push(ni)
    }
  }
}

export function decideMonsterIntent(
  state: GameState,
  m: Actor,
  flow: Int16Array,
  visible: Uint8Array,
  occ: (Actor | null)[],
  rng: Rng,
): Intent {
  const w = state.width
  const h = state.height
  const idx = m.y * w + m.x

  // Aggro symétrique : si un joueur peut le voir, il voit le joueur. Intuitif
  // pour le joueur, et gratuit puisqu'on a déjà calculé le champ de vision.
  if (visible[idx] === 1) m.aggroUntil = state.tick + AGGRO_MEMORY
  const aggro = (m.aggroUntil ?? 0) > state.tick

  // Un joueur vivant à portée de corps à corps : on frappe.
  for (const dir of DIRS) {
    const [dx, dy] = DIR_VEC[dir]
    const nx = m.x + dx
    const ny = m.y + dy
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    const t = occ[ny * w + nx]
    if (t && t.kind === 'player' && t.alive) return { type: 'attack', dir }
  }

  const d = flow[idx]!
  if (aggro && d >= 0 && d <= AGGRO_MAX_DIST) {
    let bestDir: Dir | null = null
    let bestD = d
    // Ordre aléatoire pour éviter que tous les monstres privilégient la même
    // diagonale et s'empilent en file indienne.
    for (const dir of rng.shuffle([...DIRS])) {
      const [dx, dy] = DIR_VEC[dir]
      const nx = m.x + dx
      const ny = m.y + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const ni = ny * w + nx
      const nd = flow[ni]!
      if (nd < 0 || nd >= bestD) continue
      if (occ[ni]) continue
      bestD = nd
      bestDir = dir
    }
    if (bestDir) return { type: 'move', dir: bestDir }
  }

  // Hors aggro : errance lente, pour que le donjon paraisse vivant même dans
  // le brouillard (comportement PMD : tout bouge, même ce qu'on ne voit pas).
  if (rng.chance(0.3)) return { type: 'move', dir: rng.pick(DIRS) }
  return { type: 'wait' }
}
