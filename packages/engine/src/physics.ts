/**
 * Déplacement continu dans un monde en tuiles, et géométrie des attaques.
 *
 * L'acteur est traité comme une boîte carrée de demi-côté `r` plutôt qu'un
 * cercle : la résolution axe par axe est alors exacte, stable, et donne
 * gratuitement le glissement le long des murs — c'est ce glissement qui fait
 * qu'on longe un couloir sans s'accrocher aux angles.
 */
import { isWalkable } from './types.js'

const EPS = 1e-4

export function solidAt(tiles: Uint8Array, w: number, h: number, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true
  return !isWalkable(tiles[ty * w + tx]!)
}

/**
 * Applique un déplacement en résolvant les collisions axe par axe.
 * Suppose |dx| et |dy| inférieurs à une tuile, ce qui est garanti aux vitesses
 * du jeu (4.2 tuiles/s à 30 Hz = 0.14 tuile par pas).
 */
export function moveWithCollision(
  tiles: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  r: number,
): { x: number; y: number } {
  let nx = x + dx
  let ny = y

  if (dx !== 0) {
    const minTy = Math.floor(y - r)
    const maxTy = Math.floor(y + r)
    if (dx > 0) {
      const tx = Math.floor(nx + r)
      for (let ty = minTy; ty <= maxTy; ty++) {
        if (solidAt(tiles, w, h, tx, ty)) {
          nx = tx - r - EPS
          break
        }
      }
    } else {
      const tx = Math.floor(nx - r)
      for (let ty = minTy; ty <= maxTy; ty++) {
        if (solidAt(tiles, w, h, tx, ty)) {
          nx = tx + 1 + r + EPS
          break
        }
      }
    }
  }

  ny = y + dy
  if (dy !== 0) {
    const minTx = Math.floor(nx - r)
    const maxTx = Math.floor(nx + r)
    if (dy > 0) {
      const ty = Math.floor(ny + r)
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (solidAt(tiles, w, h, tx, ty)) {
          ny = ty - r - EPS
          break
        }
      }
    } else {
      const ty = Math.floor(ny - r)
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (solidAt(tiles, w, h, tx, ty)) {
          ny = ty + 1 + r + EPS
          break
        }
      }
    }
  }

  return { x: nx, y: ny }
}

/** Écart angulaire signé, ramené dans [-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/**
 * La cible est-elle dans l'arc frappé ?
 *
 * L'arc est élargi de la taille angulaire de la cible : un monstre collé à toi
 * occupe un large secteur et devient donc facile à toucher, alors qu'un monstre
 * lointain demande de viser. Sans cette correction, un ennemi au contact mais
 * légèrement décalé est immanquablement raté — c'était le défaut du système en
 * grille.
 */
export function inAttackArc(
  ax: number,
  ay: number,
  aim: number,
  halfArc: number,
  reach: number,
  tx: number,
  ty: number,
  targetRadius: number,
): boolean {
  const dx = tx - ax
  const dy = ty - ay
  const dist = Math.hypot(dx, dy)
  if (dist > reach + targetRadius) return false
  if (dist < 1e-3) return true
  const spread = Math.atan2(targetRadius, Math.max(0.25, dist))
  return Math.abs(angleDiff(Math.atan2(dy, dx), aim)) <= halfArc + spread
}

/**
 * Empêche les acteurs de s'empiler en les repoussant doucement.
 * Sans ça les monstres convergent tous vers le même point et forment un tas
 * dans lequel on ne distingue plus rien.
 */
export function separateActors(
  actors: { x: number; y: number; alive: boolean }[],
  r: number,
): void {
  const minDist = r * 2
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i]!
    if (!a.alive) continue
    for (let j = i + 1; j < actors.length; j++) {
      const b = actors[j]!
      if (!b.alive) continue
      let dx = b.x - a.x
      let dy = b.y - a.y
      const d2 = dx * dx + dy * dy
      if (d2 >= minDist * minDist) continue

      let d = Math.sqrt(d2)
      if (d < 1e-4) {
        // Superposition parfaite : on écarte dans une direction arbitraire mais
        // déterministe, sinon la racine carrée donne NaN.
        dx = 1
        dy = 0
        d = 1
      }
      const push = (minDist - d) / 2
      const ux = (dx / d) * push
      const uy = (dy / d) * push
      a.x -= ux
      a.y -= uy
      b.x += ux
      b.y += uy
    }
  }
}
