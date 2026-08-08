/**
 * Télémétrie de partie.
 *
 * On ne peut pas équilibrer un jeu en se fiant à « je trouve ça trop facile » :
 * ça dit qu'il y a un problème, jamais lequel. Ce module accumule ce qui s'est
 * réellement passé — qui a fait mal à qui, combien de temps a duré un étage, à
 * quel niveau on était en y entrant — pour qu'on règle sur des chiffres.
 *
 * Tout est dérivé des `GameEvent` déjà émis par l'engine, plus un échantillon
 * de PV par seconde. L'engine reste pur : il ne sait pas qu'on l'observe.
 */
import { TICK_RATE, WEAPONS, effectiveHp, type GameEvent, type GameState } from '@dc/engine'

/** Compteur par clé, écrit sans avoir à initialiser chaque case. */
type Tally = Record<string, number>

function bump(tally: Tally, key: string, by = 1): void {
  if (!key) return
  tally[key] = (tally[key] ?? 0) + by
}

export interface FloorRecord {
  floor: number
  /** Ticks écoulés dans l'étage. La durée est ce qui trahit un ventre mou. */
  ticks: number
  /**
   * Monstres générés à l'arrivée sur l'étage, hors poursuivants. Rapporté aux
   * tués, c'est la mesure qui a révélé le vrai problème d'équilibrage : on ne
   * combattait pas l'étage, on le traversait.
   */
  spawned: number
  /** Monstres qui ont suivi depuis l'étage précédent — la dette qu'on traîne. */
  pursuers: number
  /**
   * PV effectifs du joueur le mieux doté sur cet étage. C'est le dénominateur
   * du K réel : sans lui, « combien de dégâts encaissés » ne veut rien dire.
   */
  poolHp: number
  /** Monstres tués, par espèce. */
  kills: Tally
  /** Dégâts infligés par les joueurs, par espèce de victime. */
  damageDealt: Tally
  /** Dégâts subis par les joueurs, par espèce responsable. */
  damageTaken: Tally
  /** Qui a mis un joueur à terre, par espèce. La question la plus utile. */
  downedBy: Tally
  /** Coups portés et coups qui touchent, par arme. Le ratio dit si l'arme vise juste. */
  swings: Tally
  hits: Tally
  damageByWeapon: Tally
  downs: number
  deaths: number
  revives: number
  xpGained: number
  levelIn: number
  levelOut: number
  /** PV les plus bas atteints par un joueur, en fraction de ses PV max. */
  lowestHpRatio: number
  /** Fraction du temps passée avec au moins un joueur sous 35 % de PV. */
  dangerRatio: number
  pickups: Tally
}

export interface RunRecord {
  room: string
  seed: number
  /** Renseigné à l'écriture : l'engine n'a pas accès à l'heure. */
  updatedAt: string
  floors: FloorRecord[]
}

/** Sous ce seuil de PV, on considère que le joueur est en danger réel. */
const DANGER_HP_RATIO = 0.35
/** L'espèce des héros, telle que l'engine la nomme dans ses événements. */
const PLAYER_SPECIES = 'hero'

function emptyFloor(floor: number, level: number): FloorRecord {
  return {
    floor,
    ticks: 0,
    spawned: 0,
    pursuers: 0,
    poolHp: 0,
    kills: {},
    damageDealt: {},
    damageTaken: {},
    downedBy: {},
    swings: {},
    hits: {},
    damageByWeapon: {},
    downs: 0,
    deaths: 0,
    revives: 0,
    xpGained: 0,
    levelIn: level,
    levelOut: level,
    lowestHpRatio: 1,
    dangerRatio: 0,
    pickups: {},
  }
}

export class RunTelemetry {
  readonly floors: FloorRecord[] = []
  private current: FloorRecord
  private dangerTicks = 0
  /**
   * Dernière espèce à avoir blessé chaque joueur. C'est ce qui permet de dire
   * « c'est le kamikaze qui t'a eu », et pas seulement « tu es tombé ».
   */
  private lastHitBy = new Map<string, string>()
  /** L'XP étant commune à l'équipe, un seul compteur suffit à suivre les gains. */
  private xpSeen = -1
  /** Recenser les monstres de l'étage, une seule fois, au tick de l'arrivée. */
  private needsCensus = true

  constructor(
    readonly room: string,
    state: GameState,
    previous?: RunRecord | null,
  ) {
    if (previous?.floors?.length) this.floors.push(...previous.floors)
    const resumed = this.floors.find((f) => f.floor === state.floor)
    this.current = resumed ?? emptyFloor(state.floor, this.levelOf(state))
    if (!resumed) this.floors.push(this.current)
    // Sur une reprise, le recensement d'origine est déjà dans le relevé : le
    // refaire ne compterait que les survivants et effacerait la vraie valeur.
    this.needsCensus = !resumed
  }

  private levelOf(state: GameState): number {
    let best = 1
    for (const a of Object.values(state.actors)) {
      if (a.kind === 'player') best = Math.max(best, a.level ?? 1)
    }
    return best
  }

  /** À appeler une fois par tick, après `step()`. */
  observe(state: GameState, events: GameEvent[]): void {
    this.current.ticks += 1

    for (const ev of events) this.record(state, ev)

    if (this.needsCensus) {
      this.needsCensus = false
      this.current.spawned = Object.values(state.actors).filter(
        (a) => a.kind === 'monster',
      ).length
    }

    let lowest = 1
    let inDanger = false
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player' || !a.alive || a.downed) continue
      const ratio = a.maxHp > 0 ? a.hp / a.maxHp : 1
      lowest = Math.min(lowest, ratio)
      if (ratio < DANGER_HP_RATIO) inDanger = true
      // PV effectifs, armure comprise le jour où il y en aura : c'est cette
      // grandeur-là que le modèle équilibre, jamais les PV bruts.
      this.current.poolHp = Math.max(this.current.poolHp, effectiveHp(a.maxHp, a.armor ?? 0))
    }
    if (lowest < this.current.lowestHpRatio) this.current.lowestHpRatio = lowest
    if (inDanger) this.dangerTicks += 1
    this.current.dangerRatio = this.current.ticks ? this.dangerTicks / this.current.ticks : 0

    // L'XP est commune à l'équipe : un seul compteur, sinon on la compterait
    // autant de fois qu'il y a de joueurs connectés.
    let xp = -1
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player') continue
      xp = Math.max(xp, a.xp ?? 0)
      this.current.levelOut = Math.max(this.current.levelOut, a.level ?? 1)
    }
    if (xp >= 0) {
      if (this.xpSeen >= 0 && xp > this.xpSeen) this.current.xpGained += xp - this.xpSeen
      this.xpSeen = xp
    }
  }

  private record(state: GameState, ev: GameEvent): void {
    switch (ev.t) {
      case 'swing': {
        const actor = state.actors[ev.id]
        if (actor?.kind === 'player') bump(this.current.swings, actor.weapon ?? 'sword')
        break
      }

      case 'hit': {
        // Les deux espèces sont portées par l'événement : l'auteur comme la
        // victime peuvent avoir disparu avant qu'on lise l'état.
        if (ev.fromSpecies === PLAYER_SPECIES) {
          const weapon = state.actors[ev.from]?.weapon ?? 'sword'
          bump(this.current.damageDealt, ev.toSpecies, ev.dmg)
          bump(this.current.hits, weapon)
          bump(this.current.damageByWeapon, weapon, ev.dmg)
        } else if (ev.toSpecies === PLAYER_SPECIES) {
          bump(this.current.damageTaken, ev.fromSpecies || 'inconnu', ev.dmg)
          this.lastHitBy.set(ev.to, ev.fromSpecies || 'inconnu')
        }
        // Reste le cas monstre → monstre (l'explosion du kamikaze), qui
        // n'apprend rien sur l'équilibrage : on l'ignore.
        break
      }

      case 'death':
        if (ev.kind === 'monster') bump(this.current.kills, ev.species)
        else this.current.deaths += 1
        break

      case 'downed':
        this.current.downs += 1
        bump(this.current.downedBy, this.lastHitBy.get(ev.id) ?? 'inconnu')
        break

      case 'revived':
        this.current.revives += 1
        break

      case 'pickup':
        bump(this.current.pickups, ev.kind)
        break

      case 'descend': {
        const level = this.current.levelOut
        this.current = emptyFloor(ev.floor, level)
        this.floors.push(this.current)
        this.dangerTicks = 0
        this.needsCensus = true
        break
      }

      // Émis juste après 'descend', donc sur le relevé du nouvel étage : c'est
      // bien la dette qu'on emmène, pas celle qu'on avait en arrivant.
      case 'pursuit':
        this.current.pursuers = ev.count
        break

      default:
        break
    }
  }

  toRecord(seed: number, now: string): RunRecord {
    return { room: this.room, seed, updatedAt: now, floors: this.floors }
  }
}

/** Résumé lisible d'un étage, utilisé par le rapport et par les tests. */
/**
 * Les deux invariants du modèle de puissance, mesurés sur ce qui s'est
 * réellement passé plutôt que calculés sur le papier.
 *
 * `ttk` — coups **qui touchent** nécessaires pour tuer, multipliés par la
 * cadence de l'arme. Directement comparable à TARGET_TTK.
 *
 *   On compte les touches et pas les coups portés, et c'est essentiel : un
 *   joueur qui garde le clic enfoncé en traversant l'étage frappe deux à trois
 *   fois plus souvent qu'il ne touche. Compter les coups mesurerait sa
 *   discipline de gâchette, pas la solidité des monstres.
 *
 * `k` — monstres tués avant d'épuiser sa barre de vie.
 *
 *   Attention : ce n'est PAS comparable au K analytique de `scripts/curve.ts`.
 *   Le K analytique est un pire cas — trois monstres qui frappent sans
 *   discontinuer. Le K mesuré inclut tout ce que le joueur fait pour l'éviter :
 *   reculer, repousser, tuer avant le contact, ramasser un cœur. Il sera
 *   toujours bien plus haut. Ce qui compte ici, c'est **sa platitude** : s'il
 *   grimpe avec la profondeur, le jeu devient plus facile à mesure qu'on
 *   descend.
 *
 * Les deux valent `null` quand l'étage n'a pas assez de matière pour être
 * honnête — mieux vaut ne rien dire qu'un chiffre tiré de deux événements.
 */
export function floorInvariants(f: FloorRecord): { ttk: number | null; k: number | null } {
  const kills = Object.values(f.kills).reduce((a, b) => a + b, 0)
  const taken = Object.values(f.damageTaken).reduce((a, b) => a + b, 0)

  let connectedSeconds = 0
  for (const [weaponId, n] of Object.entries(f.hits)) {
    const w = WEAPONS[weaponId]
    if (w) connectedSeconds += (n * w.cooldown) / TICK_RATE
  }

  // `poolHp` manque sur les relevés d'avant le modèle de puissance : mieux vaut
  // ne rien afficher qu'un NaN qui ressemble à une mesure.
  const pool = f.poolHp ?? 0
  return {
    ttk: kills >= 3 && connectedSeconds > 0 ? connectedSeconds / kills : null,
    k: kills >= 3 && taken > 0 && pool > 0 ? (pool * kills) / taken : null,
  }
}

export function floorSummary(f: FloorRecord): string {
  const seconds = (f.ticks / TICK_RATE).toFixed(0)
  const kills = Object.values(f.kills).reduce((a, b) => a + b, 0)
  const taken = Object.values(f.damageTaken).reduce((a, b) => a + b, 0)
  const present = f.spawned + f.pursuers
  const left = present > 0 ? Math.max(0, present - kills) : 0
  const { ttk, k } = floorInvariants(f)
  return (
    `étage ${f.floor} · ${seconds}s · niveau ${f.levelIn}→${f.levelOut} · ` +
    `${kills}/${present} tués` +
    (f.pursuers ? ` (dont ${f.pursuers} suiveur${f.pursuers > 1 ? 's' : ''})` : '') +
    ` · ${left} laissé(s) · ${taken} dégâts subis · ${f.downs} mise(s) à terre · ` +
    `PV au plus bas ${(f.lowestHpRatio * 100).toFixed(0)}% · ` +
    `en danger ${(f.dangerRatio * 100).toFixed(0)}% du temps · ` +
    `TTK ${ttk === null ? '—' : ttk.toFixed(2) + 's'} · K ${k === null ? '—' : k.toFixed(1)}`
  )
}
