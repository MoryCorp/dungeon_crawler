/**
 * IA des monstres.
 *
 * Le pathfinding reste sur la grille (un seul BFS par tick pour tout le monde,
 * les monstres descendent le gradient), mais le déplacement produit est un
 * vecteur continu. En ligne de vue directe, on vise le joueur plutôt que le
 * centre de la tuile suivante : suivre les tuiles en terrain dégagé donne une
 * trajectoire en escalier, visible et laide.
 */
import { hasLineOfSight } from './fov.js'
import { angleDiff } from './physics.js'
import type { Actor, GameState } from './types.js'
import { AGGRO_MAX_DIST, AGGRO_MEMORY, MONSTERS, TICK_RATE, isWalkable } from './types.js'

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]

/** Distance de chaque tuile au joueur vivant le plus proche (-1 = inatteignable). */
export function buildFlowField(state: GameState, out: Int16Array, maxDist: number): void {
  out.fill(-1)
  const w = state.width
  const h = state.height
  const queue: number[] = []

  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive) continue
    const idx = Math.floor(a.y) * w + Math.floor(a.x)
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

    for (const [dx, dy] of NEIGHBOURS) {
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

export type MonsterAction =
  | { type: 'move'; mx: number; my: number; aim: number }
  | { type: 'windup'; aim: number }
  | { type: 'idle'; aim: number }

function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function nearestPlayer(state: GameState, m: Actor): Actor | null {
  let best: Actor | null = null
  let bestD = Infinity
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive) continue
    const d = (a.x - m.x) ** 2 + (a.y - m.y) ** 2
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

export function decideMonsterAction(
  state: GameState,
  m: Actor,
  flow: Int16Array,
  visible: Uint8Array,
): MonsterAction {
  const w = state.width
  const def = MONSTERS[m.species]!
  const tx = Math.floor(m.x)
  const ty = Math.floor(m.y)
  const idx = ty * w + tx

  // Aggro symétrique : si l'équipe peut le voir, il voit l'équipe.
  if (visible[idx] === 1) m.aggroUntil = state.tick + AGGRO_MEMORY
  const aggro = (m.aggroUntil ?? 0) > state.tick

  const target = nearestPlayer(state, m)
  const aim = target ? Math.atan2(target.y - m.y, target.x - m.x) : m.aim

  // Coup déjà en préparation : il reste planté, c'est la fenêtre d'esquive.
  if (m.windupUntil && state.tick < m.windupUntil) {
    return { type: 'windup', aim: m.aim }
  }

  if (target && aggro && state.tick >= m.readyAt) {
    const dist = Math.hypot(target.x - m.x, target.y - m.y)
    if (dist <= def.reach) return { type: 'windup', aim }
  }

  if (target && aggro) {
    const dist = Math.hypot(target.x - m.x, target.y - m.y)
    const seesDirectly = hasLineOfSight(
      state.tiles, w, tx, ty, Math.floor(target.x), Math.floor(target.y),
    )

    // Assez près et en vue : on fonce droit dessus.
    if (seesDirectly && dist < AGGRO_MAX_DIST) {
      return { type: 'move', mx: Math.cos(aim), my: Math.sin(aim), aim }
    }

    // Sinon on descend le gradient vers le centre de la meilleure tuile voisine.
    const here = flow[idx]!
    if (here >= 0) {
      let bestX = 0
      let bestY = 0
      let bestD = here
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = tx + dx
        const ny = ty + dy
        if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue
        const nd = flow[ny * w + nx]!
        if (nd < 0 || nd >= bestD) continue
        bestD = nd
        bestX = nx
        bestY = ny
      }
      if (bestD < here) {
        const gx = bestX + 0.5 - m.x
        const gy = bestY + 0.5 - m.y
        const len = Math.hypot(gx, gy) || 1
        return { type: 'move', mx: gx / len, my: gy / len, aim: Math.atan2(gy, gx) }
      }
    }
  }

  // Hors aggro : errance lente. La direction est dérivée de l'identifiant et du
  // temps, ce qui évite de stocker un état de patrouille par monstre tout en
  // restant déterministe.
  const phase = hashId(m.id) + Math.floor(state.tick / (TICK_RATE * 2))
  const wanderAngle = ((Math.imul(phase, 2654435761) >>> 0) / 4294967296) * Math.PI * 2
  const moving = (Math.imul(phase ^ 0x9e37, 40503) >>> 0) % 3 !== 0
  if (!moving) return { type: 'idle', aim: m.aim }
  return {
    type: 'move',
    mx: Math.cos(wanderAngle) * 0.45,
    my: Math.sin(wanderAngle) * 0.45,
    aim: wanderAngle,
  }
}

/** Rotation progressive vers un angle cible, pour éviter les demi-tours instantanés. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(target, current)
  if (Math.abs(d) <= maxStep) return target
  return current + Math.sign(d) * maxStep
}
