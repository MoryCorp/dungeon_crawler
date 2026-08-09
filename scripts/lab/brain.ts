/**
 * Le cerveau d'un bot de laboratoire.
 *
 * Un bot est une politique paramétrée — son « génome » — qui lit l'état complet
 * du jeu et rend un PlayerInput par tick, exactement comme un joueur. Il vit
 * entièrement hors de l'engine : il ne consomme pas le RNG de la partie (il a
 * le sien), ne modifie rien, et `step()` reste pur. Deux bots au même génome
 * sur la même graine produisent la même partie.
 *
 * Le but n'est pas de faire un bot fort, mais un bot **réglable** : chaque
 * paramètre du génome est un trait de style qu'on peut faire varier pour
 * cartographier ce que la difficulté exige. La couche d'humanisation dégrade
 * la perception (retard de réaction, visée bruitée, décisions espacées) pour
 * mesurer combien le jeu pardonne l'imperfection — l'écart entre le bot
 * optimal et le bot humanisé est la vraie réponse à « est-ce jouable ».
 */
import {
  MAP_H,
  MAP_W,
  MONSTERS,
  healCapOf,
  NEUTRAL_INPUT,
  REVIVE_RANGE,
  Rng,
  WEAPONS,
  hasLineOfSight,
  isWalkable,
  type Actor,
  type GameState,
  type PlayerInput,
} from '@dc/engine'

// ---------------------------------------------------------------- le génome

export type Objective = 'clear' | 'rush' | 'balanced'
export type SprintPolicy = 'travel' | 'escape' | 'both' | 'never'

export interface Genome {
  weapon: string
  /** clear = nettoie tout · rush = clé puis escalier · balanced = ce qui gêne. */
  objective: Objective
  /** Distance préférée pendant la récupération de l'arme. 0 = on encaisse. */
  kite: number
  /** 0..1 : qualité d'esquive des télégraphes, charges et projectiles. */
  dodge: number
  /** On ramasse un cœur sous ce ratio de PV. */
  heartAt: number
  sprint: SprintPolicy
  /** Ratio de PV sous lequel on décroche du combat. */
  fleeAt: number
  /** Au-delà de ce nombre d'ennemis engagés, on recule en frappant. */
  engageCap: number
  /** 0..1 : rayon d'agression en mode balanced (0 = fonce, 1 = ratisse large). */
  patience: number
}

/** Limitations humaines. `null` = bot optimal (réflexes et visée parfaits). */
export interface Humanization {
  /** Retard entre décision et action, en ticks (~8 = 267 ms). */
  reactionTicks: number
  /** Écart-type du bruit de visée, en radians. */
  aimJitter: number
  /** On ne re-décide que tous les N ticks (~5 = 166 ms) ; entre-temps on répète. */
  decideEvery: number
}

export const HUMAN: Humanization = { reactionTicks: 8, aimJitter: 0.09, decideEvery: 5 }

// ------------------------------------------------------------- pathfinding

/**
 * BFS depuis la cible : chaque case porte sa distance de chemin réel. Repris
 * du bot d'équilibrage (`scripts/botrun.ts`) — les bots n'ont pas accès au
 * champ de flux de l'engine, qui pointe vers les joueurs, pas l'inverse.
 */
export function distancesTo(state: GameState, gx: number, gy: number): Int16Array {
  const dist = new Int16Array(MAP_W * MAP_H).fill(-1)
  const start = gy * MAP_W + gx
  if (start < 0 || start >= dist.length || !isWalkable(state.tiles[start]!)) return dist
  dist[start] = 0
  const queue = [start]
  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]!
    const d = dist[idx]!
    const x = idx % MAP_W
    const y = (idx / MAP_W) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 1 || ny < 1 || nx >= MAP_W - 1 || ny >= MAP_H - 1) continue
      const ni = ny * MAP_W + nx
      if (dist[ni] !== -1 || !isWalkable(state.tiles[ni]!)) continue
      dist[ni] = d + 1
      queue.push(ni)
    }
  }
  return dist
}

/**
 * Direction pour descendre le gradient — avec du string-pulling : on suit le
 * chemin BFS sur plusieurs tuiles et on vise la plus lointaine encore en ligne
 * de vue. Viser la tuile voisine faisait des escaliers, et ces zigzags,
 * combinés au retard de réaction humain (décision -> effet 8 ticks plus tard),
 * dégénéraient en oscillation sur place : le bot restait coincé 80 secondes
 * contre un angle de mur. Un cap stable sur plusieurs tuiles amortit la boucle.
 */
function stepToward(state: GameState, me: Actor, dist: Int16Array): [number, number] {
  let tx = Math.floor(me.x)
  let ty = Math.floor(me.y)
  const here = dist[ty * MAP_W + tx] ?? -1
  if (here <= 0) return [0, 0]

  // Dérouler le chemin sur au plus 10 tuiles.
  const path: [number, number][] = []
  let d = here
  for (let i = 0; i < 10 && d > 0; i++) {
    let next: [number, number] | null = null
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nd = dist[(ty + dy) * MAP_W + (tx + dx)] ?? -1
      if (nd < 0 || nd >= d) continue
      d = nd
      next = [tx + dx, ty + dy]
    }
    if (!next) break
    path.push(next)
    ;[tx, ty] = next
  }
  if (path.length === 0) return [0, 0]

  // La tuile la plus lointaine du chemin qu'on voit encore : le cap.
  let target = path[0]!
  for (let i = path.length - 1; i >= 0; i--) {
    const [px, py] = path[i]!
    if (hasLineOfSight(state.tiles, MAP_W, Math.floor(me.x), Math.floor(me.y), px, py)) {
      target = path[i]!
      break
    }
  }
  const gx = target[0] + 0.5 - me.x
  const gy = target[1] + 0.5 - me.y
  const len = Math.hypot(gx, gy) || 1
  return [gx / len, gy / len]
}

/** S'éloigner d'un point en restant praticable : monte le gradient du BFS. */
function stepAway(state: GameState, me: Actor, dist: Int16Array): [number, number] {
  const tx = Math.floor(me.x)
  const ty = Math.floor(me.y)
  const here = dist[ty * MAP_W + tx] ?? -1
  if (here < 0) return [0, 0]
  let best = here
  let goal: [number, number] | null = null
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nd = dist[(ty + dy) * MAP_W + (tx + dx)] ?? -1
    if (nd <= best) continue
    best = nd
    goal = [tx + dx, ty + dy]
  }
  if (!goal) return [0, 0]
  const gx = goal[0] + 0.5 - me.x
  const gy = goal[1] + 0.5 - me.y
  const len = Math.hypot(gx, gy) || 1
  return [gx / len, gy / len]
}

// --------------------------------------------------------------- le cerveau

/** Distance de tir efficace par arme — pas la portée nominale. */
function attackRange(weapon: string): number {
  if (weapon === 'bow') return 6
  return (WEAPONS[weapon]?.reach ?? 1.4) * 0.95
}

/** Distance qu'on cherche à tenir pendant la récupération. */
function holdRange(weapon: string, kite: number): number {
  if (weapon === 'bow') return Math.max(4, kite + 3)
  if (weapon === 'spear') return Math.max(1.9, kite)
  return kite
}

export class Brain {
  lastBranch = ''
  private dodgeStreak = 0
  private rng: Rng
  private queue: PlayerInput[] = []
  private cached: PlayerInput = { ...NEUTRAL_INPUT }
  private sinceDecision = 0
  /** Anti-blocage : position d'il y a 2 s, et écart en cours. */
  private anchorX = -1
  private anchorY = -1
  private anchorTick = 0
  private jinkUntil = 0
  private jinkX = 0
  private jinkY = 0
  private stuckStreak = 0

  constructor(
    readonly id: string,
    readonly genome: Genome,
    readonly human: Humanization | null,
    seed: number,
  ) {
    this.rng = new Rng((seed ^ 0x5bd1e995) | 0)
  }

  /** Un input par tick. Toute la latence humaine est modélisée ici. */
  tick(state: GameState): PlayerInput {
    const h = this.human
    this.sinceDecision++
    if (!h || this.sinceDecision >= (h?.decideEvery ?? 1)) {
      this.sinceDecision = 0
      let input = this.decide(state)
      input = this.unstick(state, input)
      if (h && h.aimJitter > 0) {
        // Somme de deux uniformes ≈ gaussienne, sans dépendance.
        const noise = (this.rng.next() + this.rng.next() - 1) * h.aimJitter * 2
        input = { ...input, aim: input.aim + noise }
      }
      this.cached = input
    }
    if (!h || h.reactionTicks <= 0) return this.cached
    // File de réaction : ce qu'on décide maintenant n'agit que dans N ticks.
    this.queue.push(this.cached)
    if (this.queue.length > h.reactionTicks) return this.queue.shift()!
    return { ...NEUTRAL_INPUT }
  }

  /**
   * Boucle fermée avec retard (décision -> réaction -> effet) = oscillations
   * possibles autour d'un angle de mur, jusqu'au sur-place parfait. Plutôt que
   * d'amortir la boucle, on fait ce que fait un humain coincé : un écart de
   * côté pendant une demi-seconde, puis on reprend.
   */
  private unstick(state: GameState, input: PlayerInput): PlayerInput {
    const me = state.actors[this.id]
    if (!me || !me.alive || me.downed) return input

    if (state.tick < this.jinkUntil) {
      return { ...input, mx: this.jinkX, my: this.jinkY }
    }

    const wantsMove = Math.abs(input.mx) + Math.abs(input.my) > 0.1
    if (state.tick - this.anchorTick >= 60) {
      const moved = Math.hypot(me.x - this.anchorX, me.y - this.anchorY)
      if (wantsMove && this.anchorX >= 0 && moved < 0.5) {
        // Toujours coincé après le dernier écart : on insiste plus longtemps.
        this.stuckStreak++
        // Une direction dont la case à deux tuiles est praticable, sinon on
        // pousse un mur pendant tout l'écart.
        const start = this.rng.int(8)
        for (let i = 0; i < 8; i++) {
          const ang = ((start + i) % 8) * (Math.PI / 4)
          const cx = Math.floor(me.x + Math.cos(ang) * 2)
          const cy = Math.floor(me.y + Math.sin(ang) * 2)
          const tile = state.tiles[cy * MAP_W + cx]
          if (tile !== undefined && isWalkable(tile)) {
            this.jinkX = Math.cos(ang)
            this.jinkY = Math.sin(ang)
            break
          }
        }
        this.jinkUntil = state.tick + Math.min(75, 15 * this.stuckStreak)
      } else if (moved >= 0.5) {
        this.stuckStreak = 0
      }
      this.anchorX = me.x
      this.anchorY = me.y
      this.anchorTick = state.tick
    }
    return input
  }

  // eslint-disable-next-line complexity
  private decide(state: GameState): PlayerInput {
    const me = state.actors[this.id]
    if (!me || !me.alive) return { ...NEUTRAL_INPUT }
    const g = this.genome
    const hpRatio = me.maxHp > 0 ? me.hp / me.maxHp : 1

    // À terre : ramper vers le coéquipier debout le plus proche.
    if (me.downed) {
      const mate = this.nearestPlayer(state, me, (a) => a.alive && !a.downed)
      if (!mate) return { ...NEUTRAL_INPUT }
      const d = distancesTo(state, Math.floor(mate.x), Math.floor(mate.y))
      const [mx, my] = stepToward(state, me, d)
      return { mx, my, aim: me.aim, attack: false, sprint: false }
    }

    const threats = this.threats(state, me, 7)
    const nearest = threats[0] ?? null
    const nearestDist = nearest ? Math.hypot(nearest.x - me.x, nearest.y - me.y) : Infinity

    // Relever un coéquipier passe avant tout, sauf si on est soi-même au bord.
    // Mais un seul secouriste suffit : si un autre debout est plus proche du
    // corps, on couvre en se battant au lieu de s'agglutiner — mesuré en
    // quatuor, deux secouristes sous le feu de mages statiques font une boucle
    // relevé/à terre infinie que personne ne casse jamais.
    const downedMate = this.nearestPlayer(state, me, (a) => a.alive && a.downed === true)
    const closerHelper = downedMate
      ? this.nearestPlayer(state, downedMate, (a) =>
          a.alive && !a.downed && a.id !== this.id &&
          Math.hypot(a.x - downedMate.x, a.y - downedMate.y) <
            Math.hypot(me.x - downedMate.x, me.y - downedMate.y))
      : null
    if (downedMate && !closerHelper && hpRatio > g.fleeAt) {
      const d = Math.hypot(downedMate.x - me.x, downedMate.y - me.y)
      const aim = nearest
        ? Math.atan2(nearest.y - me.y, nearest.x - me.x)
        : Math.atan2(downedMate.y - me.y, downedMate.x - me.x)
      this.lastBranch = 'revive'
      if (d <= REVIVE_RANGE * 0.8) {
        // On tient la position ; on se défend quand même.
        return { mx: 0, my: 0, aim, attack: this.shouldAttack(state, me, nearest, nearestDist), sprint: false }
      }
      const dist = distancesTo(state, Math.floor(downedMate.x), Math.floor(downedMate.y))
      const [mx, my] = stepToward(state, me, dist)
      return { mx, my, aim, attack: this.shouldAttack(state, me, nearest, nearestDist), sprint: false }
    }

    // Esquive : la qualité du génome décide si on voit venir le coup.
    // Plafonnée en rafale : face à un tireur statique, le vecteur d'esquive
    // existe à chaque décision et le bot gèlerait sur place pour toujours —
    // mesuré en quatuor dans la salle piégée. Un humain esquive en avançant :
    // toutes les quelques esquives, on rend une décision aux autres branches.
    const dodge = this.dodgeVector(state, me)
    if (dodge && this.dodgeStreak < 4 && this.rng.next() < g.dodge) {
      this.dodgeStreak++
      this.lastBranch = 'dodge'
      const aim = nearest ? Math.atan2(nearest.y - me.y, nearest.x - me.x) : me.aim
      return {
        mx: dodge[0], my: dodge[1], aim,
        attack: this.shouldAttack(state, me, nearest, nearestDist),
        sprint: false,
      }
    }
    this.dodgeStreak = 0

    // Un cœur quand on saigne : petit détour seulement, pas une expédition.
    if (hpRatio < g.heartAt) {
      const heart = this.nearestItem(state, me, 'heart', 7)
      if (heart) {
        this.lastBranch = 'heart'
        const d = distancesTo(state, Math.floor(heart.x), Math.floor(heart.y))
        const [mx, my] = stepToward(state, me, d)
        const aim = nearest ? Math.atan2(nearest.y - me.y, nearest.x - me.x) : Math.atan2(heart.y - me.y, heart.x - me.x)
        return {
          mx, my, aim,
          attack: this.shouldAttack(state, me, nearest, nearestDist),
          sprint: false,
        }
      }
    }

    // Décrochage : sous le seuil, on tourne le dos et on met de la distance.
    // C'est le moment de boire ce qu'on porte — souffle ou vitesse, les deux
    // servent à mettre de la distance, et une fiole gardée sur un cadavre n'a
    // servi à personne.
    if (hpRatio < g.fleeAt && threats.length > 0) {
      this.lastBranch = 'flee'
      const input = this.retreat(
        state, me, threats,
        g.sprint === 'escape' || g.sprint === 'both',
        nearest, nearestDist,
      )
      return me.potion !== undefined ? { ...input, drink: true } : input
    }

    // Débordé : on recule en frappant — vers l'entrée, ce qui mène aux couloirs.
    if (threats.length > g.engageCap) {
      this.lastBranch = 'overwhelmed'
      return this.retreat(state, me, threats, false, nearest, nearestDist)
    }

    // Combat.
    if (nearest) {
      this.lastBranch = `fight:${nearest.species}@${nearestDist.toFixed(1)}`
      return this.fight(state, me, nearest, nearestDist)
    }

    // Plus de menace : l'étal d'abord si on a de quoi payer utile — un bot
    // qui meurt riche fausserait la mesure du puits autant qu'un joueur.
    const stall = this.shopTarget(state, me, hpRatio)
    if (stall) {
      const d = distancesTo(state, Math.floor(stall.x), Math.floor(stall.y))
      // Article inatteignable (posé hors du praticable, porte fermée…) : on
      // passe son chemin plutôt que de camper dessus jusqu'au coincement.
      if (d[Math.floor(me.y) * MAP_W + Math.floor(me.x)] === -1) {
        this.lastBranch = 'travel'
        return this.travel(state, me)
      }
      this.lastBranch = 'shop'
      const [mx, my] = stepToward(state, me, d)
      const g2 = this.genome
      return {
        mx, my, aim: me.aim, attack: false,
        sprint: g2.sprint === 'travel' || g2.sprint === 'both',
      }
    }

    // Plus de menace : l'objectif.
    this.lastBranch = 'travel'
    return this.travel(state, me)
  }

  /**
   * Y a-t-il un achat utile et payable sur l'étage ? Le plafond passe avant
   * tout (c'est le seul achat permanent), le soin quand on est entamé, une
   * fiole quand la fente est libre et la bourse confortable. Jamais le
   * coffre : son arme aléatoire écraserait le génome qu'on mesure.
   */
  private shopTarget(state: GameState, me: Actor, hpRatio: number): { x: number; y: number } | null {
    const cap = healCapOf(state)
    let best: { x: number; y: number } | null = null
    let bestScore = -Infinity
    for (const it of state.items) {
      if (it.price === undefined || state.bones < it.price) continue
      let score: number
      if (it.kind === 'cap') {
        if (cap >= 1) continue
        score = 3
      } else if (it.kind === 'soin') {
        if (hpRatio >= cap * 0.9) continue
        score = 2
      } else if (it.kind === 'fiole_souffle' || it.kind === 'fiole_vitesse') {
        if (me.potion !== undefined || state.bones < it.price * 2) continue
        score = 1
      } else {
        continue
      }
      const d = Math.hypot(it.x - me.x, it.y - me.y)
      score -= d / 100
      if (score > bestScore) {
        bestScore = score
        best = it
      }
    }
    return best
  }

  // ------------------------------------------------------------ perceptions

  private threats(state: GameState, me: Actor, radius: number): Actor[] {
    const out: Actor[] = []
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'monster' || !a.alive) continue
      if (Math.hypot(a.x - me.x, a.y - me.y) <= radius) out.push(a)
    }
    out.sort(
      (a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y),
    )
    return out
  }

  private nearestPlayer(
    state: GameState, me: Actor, ok: (a: Actor) => boolean,
  ): Actor | null {
    let best: Actor | null = null
    let bestD = Infinity
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player' || a.id === me.id || !ok(a)) continue
      const d = Math.hypot(a.x - me.x, a.y - me.y)
      if (d < bestD) {
        bestD = d
        best = a
      }
    }
    return best
  }

  private nearestItem(
    state: GameState, me: Actor, kind: string, radius: number,
  ): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null
    let bestD = radius
    for (const it of state.items) {
      if (it.kind !== kind) continue
      const d = Math.hypot(it.x - me.x, it.y - me.y)
      if (d < bestD) {
        bestD = d
        best = it
      }
    }
    return best
  }

  /**
   * Y a-t-il un coup à esquiver ? Rend un vecteur de fuite latérale, ou null.
   * Trois dangers télégraphiés : la préparation d'un monstre dont l'arc nous
   * contient, une charge en cours qui pointe vers nous, un projectile dont la
   * trajectoire nous croise.
   */
  private dodgeVector(state: GameState, me: Actor): [number, number] | null {
    for (const m of Object.values(state.actors)) {
      if (m.kind !== 'monster' || !m.alive) continue
      const def = MONSTERS[m.species]
      if (!def) continue
      const dx = me.x - m.x
      const dy = me.y - m.y
      const dist = Math.hypot(dx, dy)

      const winding = m.windupUntil !== undefined && m.windupUntil > state.tick
      if (winding && dist < def.reach + 0.6) {
        const toMe = Math.atan2(dy, dx)
        let delta = toMe - m.aim
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        if (Math.abs(delta) < 1.1) {
          // Sortir de l'arc : perpendiculaire à sa visée, du côté déjà entamé.
          const side = delta >= 0 ? 1 : -1
          return [-Math.sin(m.aim) * side, Math.cos(m.aim) * side]
        }
      }

      const dashing = m.dashUntil !== undefined && m.dashUntil > state.tick
      if (dashing && dist < 3.5) {
        const side = this.rng.chance(0.5) ? 1 : -1
        return [-Math.sin(m.aim) * side, Math.cos(m.aim) * side]
      }
    }

    for (const p of state.projectiles) {
      if (!p.hostileToPlayers) continue
      // Point d'approche minimale dans la demi-seconde à venir.
      const rx = me.x - p.x
      const ry = me.y - p.y
      const v2 = p.vx * p.vx + p.vy * p.vy
      if (v2 < 0.01) continue
      const t = Math.max(0, Math.min(0.5, (rx * p.vx + ry * p.vy) / v2))
      const cx = p.x + p.vx * t - me.x
      const cy = p.y + p.vy * t - me.y
      if (Math.hypot(cx, cy) < 0.75 && Math.hypot(rx, ry) < 6) {
        const speed = Math.sqrt(v2)
        const side = rx * p.vy - ry * p.vx >= 0 ? 1 : -1
        return [(-p.vy / speed) * side, (p.vx / speed) * side]
      }
    }
    return null
  }

  // ---------------------------------------------------------------- actions

  private shouldAttack(
    state: GameState, me: Actor, target: Actor | null, dist: number,
  ): boolean {
    if (!target) return false
    if (dist > attackRange(this.genome.weapon)) return false
    return hasLineOfSight(
      state.tiles, state.width,
      Math.floor(me.x), Math.floor(me.y),
      Math.floor(target.x), Math.floor(target.y),
    )
  }

  private fight(state: GameState, me: Actor, target: Actor, dist: number): PlayerInput {
    const g = this.genome
    const aim = Math.atan2(target.y - me.y, target.x - me.x)
    const attack = this.shouldAttack(state, me, target, dist)
    const range = attackRange(g.weapon)
    const hold = holdRange(g.weapon, g.kite)
    const recovering = me.readyAt > state.tick
    // À portée mais sans ligne de vue = un mur entre nous : il faut approcher
    // quand même, sinon un archer reste planté à fixer le mur sans tirer.
    const blocked = !attack && dist <= range * 0.9

    let mx = 0
    let my = 0
    if (!blocked && recovering && hold > 0 && dist < hold) {
      // Récupération : on rompt à la distance choisie, dos à la cible.
      mx = -Math.cos(aim)
      my = -Math.sin(aim)
    } else if (blocked || dist > range * 0.9) {
      const d = distancesTo(state, Math.floor(target.x), Math.floor(target.y))
      ;[mx, my] = stepToward(state, me, d)
      if (mx === 0 && my === 0) {
        mx = Math.cos(aim)
        my = Math.sin(aim)
      }
    }
    return { mx, my, aim, attack, sprint: false }
  }

  private retreat(
    state: GameState,
    me: Actor,
    threats: Actor[],
    sprint: boolean,
    target: Actor | null = null,
    targetDist = Infinity,
  ): PlayerInput {
    // Fuir le centre de masse par le chemin praticable : monter le gradient
    // du BFS centré sur les menaces évite de reculer dans un mur.
    let cx = 0
    let cy = 0
    for (const t of threats) {
      cx += t.x
      cy += t.y
    }
    cx /= threats.length
    cy /= threats.length
    const dist = distancesTo(state, Math.floor(cx), Math.floor(cy))
    const [ax, ay] = stepAway(state, me, dist)
    if (ax === 0 && ay === 0 && target) {
      // Cul-de-sac : reculer encore, c'est se figer contre le mur. Un animal
      // acculé se retourne — on se bat, c'est aussi ce que ferait un joueur.
      return this.fight(state, me, target, targetDist)
    }
    let mx = ax
    let my = ay
    if (mx === 0 && my === 0) {
      const away = Math.atan2(me.y - cy, me.x - cx)
      mx = Math.cos(away)
      my = Math.sin(away)
    }
    const aim = target
      ? Math.atan2(target.y - me.y, target.x - me.x)
      : Math.atan2(cy - me.y, cx - me.x)
    return {
      mx, my, aim,
      attack: this.shouldAttack(state, me, target, targetDist),
      sprint,
    }
  }

  private travel(state: GameState, me: Actor): PlayerInput {
    const g = this.genome
    const stairs = { x: state.stairs.x + 0.5, y: state.stairs.y + 0.5 }
    let goal: { x: number; y: number } = stairs

    if (g.objective === 'rush') {
      const key = state.items.find((it) => it.kind === 'key')
      const keeper = Object.values(state.actors).find(
        (a) => a.kind === 'monster' && a.alive && (a.elite === true || a.boss === true),
      )
      goal = state.stairsLocked ? (key ?? keeper ?? stairs) : stairs
    } else {
      // clear : le monstre le plus proche, où qu'il soit.
      // balanced : seulement dans un rayon proportionnel à la patience.
      const radius = g.objective === 'clear' ? Infinity : 3 + g.patience * 9
      let best: Actor | null = null
      let bestD = radius
      for (const a of Object.values(state.actors)) {
        if (a.kind !== 'monster' || !a.alive) continue
        const d = Math.hypot(a.x - me.x, a.y - me.y)
        if (d < bestD) {
          bestD = d
          best = a
        }
      }
      if (best) {
        goal = best
      } else if (state.stairsLocked) {
        const key = state.items.find((it) => it.kind === 'key')
        const keeper = Object.values(state.actors).find(
          (a) => a.kind === 'monster' && a.alive && (a.elite === true || a.boss === true),
        )
        goal = key ?? keeper ?? stairs
      }
    }

    const d = distancesTo(state, Math.floor(goal.x), Math.floor(goal.y))
    const [mx, my] = stepToward(state, me, d)
    const aim = Math.atan2(goal.y - me.y, goal.x - me.x)
    const sprint =
      (g.sprint === 'travel' || g.sprint === 'both') && (mx !== 0 || my !== 0)
    return { mx, my, aim, attack: false, sprint }
  }
}
