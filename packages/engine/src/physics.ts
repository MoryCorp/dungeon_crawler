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

/**
 * Tolérance d'accrochage aux angles, en tuiles. En tournant dans un couloir
 * avec un alignement imparfait de quelques pixels, l'ancien comportement
 * bloquait net sur le coin ; en-dessous de ce dépassement, on glisse
 * latéralement dans l'ouverture au lieu de s'arrêter. Au-delà, c'est un vrai
 * mur et il se comporte comme tel.
 */
const CORNER_NUDGE = 0.18

/** Toute la surface de l'acteur est-elle sur du sol à cette position ? */
function positionFree(
  tiles: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
): boolean {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (solidAt(tiles, w, h, tx, ty)) return false
    }
  }
  return true
}

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
    const tx = dx > 0 ? Math.floor(nx + r) : Math.floor(nx - r)
    let blocked = false
    let solidLow = false
    let solidHigh = false
    for (let ty = minTy; ty <= maxTy; ty++) {
      if (solidAt(tiles, w, h, tx, ty)) {
        blocked = true
        if (ty === minTy) solidLow = true
        if (ty === maxTy) solidHigh = true
      }
    }
    if (blocked) {
      // Accroché à un seul coin, de peu : on tente le glissement latéral dans
      // l'ouverture, et on ne le garde que si la position d'arrivée est
      // entièrement sur du sol.
      let nudged = false
      if (minTy !== maxTy && solidLow !== solidHigh) {
        const cy = solidLow ? minTy + 1 + r + EPS : maxTy - r - EPS
        const overlap = solidLow ? minTy + 1 - (y - r) : y + r - maxTy
        if (overlap <= CORNER_NUDGE && positionFree(tiles, w, h, nx, cy, r)) {
          ny = cy
          nudged = true
        }
      }
      if (!nudged) nx = dx > 0 ? tx - r - EPS : tx + 1 + r + EPS
    }
  }

  const wantY = ny + dy
  ny = wantY
  if (dy !== 0) {
    const minTx = Math.floor(nx - r)
    const maxTx = Math.floor(nx + r)
    const ty = dy > 0 ? Math.floor(ny + r) : Math.floor(ny - r)
    let blocked = false
    let solidLow = false
    let solidHigh = false
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (solidAt(tiles, w, h, tx, ty)) {
        blocked = true
        if (tx === minTx) solidLow = true
        if (tx === maxTx) solidHigh = true
      }
    }
    if (blocked) {
      let nudged = false
      if (minTx !== maxTx && solidLow !== solidHigh) {
        const cx = solidLow ? minTx + 1 + r + EPS : maxTx - r - EPS
        const overlap = solidLow ? minTx + 1 - (nx - r) : nx + r - maxTx
        if (overlap <= CORNER_NUDGE && positionFree(tiles, w, h, cx, ny, r)) {
          nx = cx
          nudged = true
        }
      }
      if (!nudged) ny = dy > 0 ? ty - r - EPS : ty + 1 + r + EPS
    }
  }

  return { x: nx, y: ny }
}

/**
 * Un projectile touche-t-il ce corps ? Le point (x, y) d'un acteur est son
 * cercle au sol, mais le sprite se dresse au-dessus : tester le seul cercle
 * laissait les flèches traverser le torse des monstres sans les toucher. On
 * teste donc une capsule verticale — du sol jusqu'à `bodyHeight` tuiles plus
 * haut — qui épouse ce que le joueur voit à l'écran.
 */
export function hitsBody(
  px: number,
  py: number,
  ax: number,
  ay: number,
  radius: number,
  bodyHeight: number,
): boolean {
  const cy = Math.min(ay, Math.max(ay - bodyHeight, py))
  return Math.hypot(ax - px, cy - py) <= radius
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
 *
 * L'écartement passe par `moveWithCollision` : une meute qui acculait un joueur
 * contre un mur finissait sinon par le pousser au travers, poussée après
 * poussée, et il se retrouvait coincé dans la pierre.
 */
export function separateActors(
  tiles: Uint8Array,
  w: number,
  h: number,
  actors: { x: number; y: number; alive: boolean; kind?: string }[],
  r: number,
): void {
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i]!
    if (!a.alive) continue
    for (let j = i + 1; j < actors.length; j++) {
      const b = actors[j]!
      if (!b.alive) continue
      // Deux monstres se tolèrent plus près l'un de l'autre qu'ils ne tolèrent
      // un joueur : à l'écartement plein (0.66 tuile), deux poursuivants qui
      // convergent vers la même embouchure de couloir (1 tuile) se poussaient
      // mutuellement dans les murs et s'y coinçaient. En laissant la meute se
      // chevaucher, le suiveur se glisse derrière le meneur et la file indienne
      // passe. Le contact avec le joueur, lui, reste à distance pleine.
      const minDist = a.kind === 'monster' && b.kind === 'monster' ? r * 2 * 0.65 : r * 2
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

      const na = moveWithCollision(tiles, w, h, a.x, a.y, -ux, -uy, r)
      a.x = na.x
      a.y = na.y
      const nb = moveWithCollision(tiles, w, h, b.x, b.y, ux, uy, r)
      b.x = nb.x
      b.y = nb.y
    }
  }
}

/**
 * Filet de sécurité : ramène sur du sol un acteur qui se retrouverait dans un
 * mur. Ne devrait jamais servir en jeu, mais une sauvegarde produite par une
 * version antérieure peut contenir un personnage coincé, et rester bloqué dans
 * la pierre est le seul bug dont on ne peut pas se sortir soi-même.
 */
export function unstick(
  tiles: Uint8Array,
  w: number,
  h: number,
  actor: { x: number; y: number },
): void {
  if (!solidAt(tiles, w, h, Math.floor(actor.x), Math.floor(actor.y))) return
  for (let radius = 1; radius <= 6; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
        const tx = Math.floor(actor.x) + dx
        const ty = Math.floor(actor.y) + dy
        if (solidAt(tiles, w, h, tx, ty)) continue
        actor.x = tx + 0.5
        actor.y = ty + 0.5
        return
      }
    }
  }
}
