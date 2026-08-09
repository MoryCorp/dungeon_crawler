/**
 * IA des monstres.
 *
 * Le pathfinding reste sur la grille (un seul BFS par tick pour tout le monde,
 * les monstres descendent le gradient), mais le déplacement produit est un
 * vecteur continu. En ligne de vue directe on vise le joueur plutôt que le
 * centre de la tuile suivante, sinon la trajectoire fait des escaliers.
 *
 * Chaque archétype décide différemment, et c'est là que se joue la variété des
 * combats : l'archer recule, le chargeur se fige avant de foncer, le kamikaze
 * ne cherche que le contact.
 */
import { hasLineOfSight } from './fov.js'
import { angleDiff } from './physics.js'
import type { Actor, GameState } from './types.js'
import {
  AGGRO_MAX_DIST,
  AGGRO_MEMORY,
  MONSTERS,
  SQUAD_ENGAGE,
  SQUAD_SLACK,
  TICK_RATE,
  isWalkable,
} from './types.js'

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]

/** Distance de chaque tuile au joueur debout le plus proche (-1 = inatteignable). */
export function buildFlowField(state: GameState, out: Int16Array, maxDist: number): void {
  out.fill(-1)
  const w = state.width
  const h = state.height
  const queue: number[] = []

  for (const a of Object.values(state.actors)) {
    // Un joueur à terre n'attire plus les monstres : ils se redéploient sur les
    // coéquipiers encore debout, ce qui laisse une chance de venir le relever.
    if (a.kind !== 'player' || !a.alive || a.downed) continue
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

function nearestTarget(state: GameState, m: Actor): Actor | null {
  let best: Actor | null = null
  let bestD = Infinity
  for (const a of Object.values(state.actors)) {
    if (a.kind !== 'player' || !a.alive) continue
    // On préfère largement une cible debout, mais on achève un joueur à terre
    // s'il n'y a plus que lui.
    const penalty = a.downed ? 1e4 : 0
    const d = (a.x - m.x) ** 2 + (a.y - m.y) ** 2 + penalty
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

/** Descente du gradient vers le centre de la meilleure tuile voisine. */
function followFlow(state: GameState, m: Actor, flow: Int16Array): MonsterAction | null {
  const w = state.width
  const tx = Math.floor(m.x)
  const ty = Math.floor(m.y)
  const here = flow[ty * w + tx]!
  if (here < 0) return null

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
  if (bestD >= here) return null

  const gx = bestX + 0.5 - m.x
  const gy = bestY + 0.5 - m.y
  const len = Math.hypot(gx, gy) || 1
  return { type: 'move', mx: gx / len, my: gy / len, aim: Math.atan2(gy, gx) }
}

function wander(state: GameState, m: Actor): MonsterAction {
  // Direction dérivée de l'identifiant et du temps : pas d'état de patrouille à
  // stocker par monstre, et ça reste déterministe.
  const phase = hashId(m.id) + Math.floor(state.tick / (TICK_RATE * 2))
  const angle = ((Math.imul(phase, 2654435761) >>> 0) / 4294967296) * Math.PI * 2
  const moving = (Math.imul(phase ^ 0x9e37, 40503) >>> 0) % 3 !== 0
  if (!moving) return { type: 'idle', aim: m.aim }
  return { type: 'move', mx: Math.cos(angle) * 0.45, my: Math.sin(angle) * 0.45, aim: angle }
}

export function decideMonsterAction(
  state: GameState,
  m: Actor,
  flow: Int16Array,
  visible: Uint8Array,
  /**
   * Distance du membre le plus en retard de son escouade, sur le champ de flux.
   * Absente quand le monstre n'appartient à aucun groupe livré.
   */
  squadLag?: number,
): MonsterAction {
  const w = state.width
  const def = MONSTERS[m.species]!
  const tx = Math.floor(m.x)
  const ty = Math.floor(m.y)

  // Aggro symétrique : si l'équipe peut le voir, il voit l'équipe.
  if (visible[ty * w + tx] === 1) m.aggroUntil = state.tick + AGGRO_MEMORY
  const aggro = (m.aggroUntil ?? 0) > state.tick

  // Coup déjà en préparation : il reste planté, c'est la fenêtre d'esquive.
  if (m.windupUntil !== undefined && state.tick < m.windupUntil) {
    return { type: 'windup', aim: m.aim }
  }

  const target = nearestTarget(state, m)
  if (!target || !aggro) return wander(state, m)

  const dx = target.x - m.x
  const dy = target.y - m.y
  const dist = Math.hypot(dx, dy)
  const aim = Math.atan2(dy, dx)
  const seesDirectly = hasLineOfSight(
    state.tiles, w, tx, ty, Math.floor(target.x), Math.floor(target.y),
  )
  const ready = state.tick >= m.readyAt

  switch (def.behavior) {
    case 'archer': {
      // Tire de loin, et recule si on lui colle dessus : il faut fermer l'écart
      // ou le contourner.
      if (ready && seesDirectly && dist <= def.reach) return { type: 'windup', aim }
      const keepAway = def.keepAway ?? 4
      if (seesDirectly && dist < keepAway) {
        return { type: 'move', mx: -Math.cos(aim), my: -Math.sin(aim), aim }
      }
      if (seesDirectly && dist <= def.reach) return { type: 'idle', aim }
      break
    }

    case 'charger': {
      // Se fige puis fonce en ligne droite : on esquive en se décalant
      // latéralement, jamais en reculant.
      if (ready && seesDirectly && dist <= def.reach && dist > 1.2) {
        return { type: 'windup', aim }
      }
      // Trop près pour s'élancer : il recule pour reprendre de l'élan.
      if (ready && seesDirectly && dist <= 1.2) {
        return { type: 'move', mx: -Math.cos(aim), my: -Math.sin(aim), aim }
      }
      break
    }

    case 'colosse': {
      // Deux distances, deux réponses : au contact il martèle (l'arc plus la
      // couronne d'éclats), à distance il se fige puis charge en ligne droite.
      // Entre les deux, il marche — lentement, c'est son poids qui l'annonce.
      if (ready && dist <= 1.7) return { type: 'windup', aim }
      if (ready && seesDirectly && dist > 3 && dist <= def.reach) {
        return { type: 'windup', aim }
      }
      break
    }

    case 'bomber': {
      // Ne cherche que le contact, et s'amorce longuement une fois collé : le
      // tuer pendant l'amorçage désamorce l'explosion. C'est la récompense.
      if (ready && dist <= def.reach) return { type: 'windup', aim }
      break
    }

    case 'melee':
    case 'swarm':
    default: {
      if (ready && dist <= def.reach) return { type: 'windup', aim }
      break
    }
  }

  // Cohésion d'escouade : celui qui a pris de l'avance patiente. Le contrôle
  // vient après les décisions d'attaque — un monstre à portée frappe, il
  // n'attend personne — et avant tout déplacement, y compris la charge à vue :
  // c'est justement l'approche qui défaisait les groupes.
  if (squadLag !== undefined && (m.squadUntil ?? 0) > state.tick) {
    const here = flow[ty * w + tx] ?? -1
    if (here >= 0 && here > SQUAD_ENGAGE && squadLag > here + SQUAD_SLACK) {
      return { type: 'idle', aim }
    }
  }

  if (seesDirectly && dist < AGGRO_MAX_DIST) {
    return { type: 'move', mx: Math.cos(aim), my: Math.sin(aim), aim }
  }
  return followFlow(state, m, flow) ?? wander(state, m)
}

/** Rotation progressive vers un angle cible, pour éviter les demi-tours instantanés. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDiff(target, current)
  if (Math.abs(d) <= maxStep) return target
  return current + Math.sign(d) * maxStep
}
