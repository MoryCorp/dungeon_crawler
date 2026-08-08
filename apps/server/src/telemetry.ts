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
import {
  FLOOR_HP_GROWTH,
  MONSTERS,
  TICK_RATE,
  WEAPONS,
  effectiveHp,
  floorScale,
  profileStats,
  type GameEvent,
  type GameState,
} from '@dc/engine'

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

  /**
   * Combien d'ennemis on affronte **en même temps**, en ticks passés à chaque
   * effectif. L'indice est le nombre de monstres hostiles à portée d'engagement
   * du joueur le plus exposé ; la dernière case regroupe tout ce qui dépasse.
   *
   * C'est la mesure qui manquait, et c'était la plus importante : tout le
   * modèle de puissance repose sur « la difficulté vient du nombre simultané,
   * pas des statistiques », et on ne mesurait justement pas la simultanéité. Un
   * étage où l'on passe son temps en tête-à-tête est un étage facile, quel que
   * soit le nombre total de monstres qu'il contient.
   */
  engaged: number[]

  /**
   * Économie des cœurs. Un joueur qui laisse les cœurs au sol tant qu'il est
   * en pleine vie se constitue une réserve : sa barre de vie n'est plus une
   * ressource qui s'épuise mais un stock qu'il rappelle à volonté, et le sens
   * de « perdre des PV » disparaît.
   */
  heartsDropped: number
  heartsTaken: number
  /** Somme des PV (en fraction) au moment de ramasser : dit s'ils sont pris à temps ou gaspillés. */
  heartHpSum: number

  /**
   * Ticks passés à moins de 5 tuiles de l'escalier d'arrivée. Camper le point
   * de sortie des poursuivants les transforme en file d'attente de cibles
   * isolées — l'exact contraire de la pression qu'ils devaient produire.
   */
  nearEntryTicks: number

  /**
   * Tailles des vagues livrées par la Directrice sur cet étage. C'est le
   * contrôle de son travail : une liste vide veut dire qu'elle n'a jamais
   * trouvé de creux — donc que la pression était continue — et des vagues de
   * deux veulent dire qu'elle a manqué de munitions.
   */
  hordes: number[]
  /** Recettes des vagues livrées : combien de fois chacune est sortie. */
  recipes?: Tally
  /**
   * Ce que le bandit a appris, par joueur : tirages et gain moyen de chaque
   * recette. Instantané de fin d'étage, comme les profils — le dernier étage
   * porte l'état le plus à jour.
   */
  bandit?: Record<string, Record<string, { n: number; mean: number }>>
  /** Monstres gardés en réserve à l'arrivée sur l'étage : ses munitions. */
  held: number

  /**
   * Profil de style de chaque joueur, tel qu'il était à la fin de l'étage.
   * C'est un instantané du cumul de la partie, pas une mesure de l'étage : le
   * dernier étage du relevé porte donc le profil le plus à jour.
   */
  profiles?: Record<
    string,
    {
      name: string
      range: number | null
      mobility: number | null
      crowding: number | null
      cohesion: number | null
      patience: number | null
    }
  >
}

/** Portée au-delà de laquelle un monstre ne pèse plus sur la décision immédiate. */
const ENGAGE_RANGE = 6
/** Au-delà, on regroupe : distinguer 11 de 12 assaillants n'apprend rien. */
const ENGAGE_BUCKETS = 11
/** Distance sous laquelle on considère que le joueur campe l'entrée. */
const ENTRY_RADIUS = 5
/** Monstre auquel on rapporte le TTK : le corps à corps le plus banal du jeu. */
const REFERENCE_SPECIES = MONSTERS.orc!

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
    engaged: new Array<number>(ENGAGE_BUCKETS + 1).fill(0),
    heartsDropped: 0,
    heartsTaken: 0,
    heartHpSum: 0,
    nearEntryTicks: 0,
    hordes: [],
    held: 0,
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
  /** PV en fraction au tick précédent, pour dater un ramassage de cœur. */
  private hpBefore = new Map<string, number>()

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
      this.current.held = state.reserveCount ?? 0
    }

    const monsters = Object.values(state.actors).filter((a) => a.kind === 'monster' && a.alive)

    let lowest = 1
    let inDanger = false
    let engagedPeak = 0
    let atEntry = false
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player' || !a.alive || a.downed) continue
      const ratio = a.maxHp > 0 ? a.hp / a.maxHp : 1
      lowest = Math.min(lowest, ratio)
      if (ratio < DANGER_HP_RATIO) inDanger = true
      // PV effectifs, armure comprise le jour où il y en aura : c'est cette
      // grandeur-là que le modèle équilibre, jamais les PV bruts.
      this.current.poolHp = Math.max(this.current.poolHp, effectiveHp(a.maxHp, a.armor ?? 0))

      // Le joueur le plus exposé donne le ton de la rencontre : c'est lui qui
      // décide si l'instant est un tête-à-tête ou une mêlée.
      let near = 0
      for (const m of monsters) {
        if (Math.hypot(m.x - a.x, m.y - a.y) <= ENGAGE_RANGE) near++
      }
      engagedPeak = Math.max(engagedPeak, near)

      if (Math.hypot(a.x - (state.spawn.x + 0.5), a.y - (state.spawn.y + 0.5)) <= ENTRY_RADIUS) {
        atEntry = true
      }

      // Conservé pour dater un ramassage de cœur : au moment où l'événement
      // arrive, le soin est déjà appliqué. C'est la valeur d'avant qui dit si
      // le cœur a été pris à temps ou gaspillé.
      this.hpBefore.set(a.id, ratio)
    }
    this.current.engaged[Math.min(engagedPeak, ENGAGE_BUCKETS)]! += 1
    if (atEntry) this.current.nearEntryTicks += 1

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

    // Instantané des profils : réécrit chaque tick, le relevé de l'étage garde
    // donc l'état de fin d'étage. Coût nul à quatre joueurs.
    const profiles: NonNullable<FloorRecord['profiles']> = {}
    for (const a of Object.values(state.actors)) {
      if (a.kind !== 'player') continue
      const p = state.profiles?.[a.id]
      if (!p) continue
      const stats = profileStats(p)
      profiles[a.id] = {
        name: a.name,
        range: stats.range,
        mobility: stats.mobility,
        crowding: stats.crowding,
        cohesion: stats.cohesion,
        patience: stats.patience,
      }
    }
    if (Object.keys(profiles).length > 0) this.current.profiles = profiles

    // Même principe pour la mémoire du bandit : instantané de fin d'étage.
    const bandit: NonNullable<FloorRecord['bandit']> = {}
    for (const [playerId, arms] of Object.entries(state.bandit ?? {})) {
      const out: Record<string, { n: number; mean: number }> = {}
      for (const [recipe, arm] of Object.entries(arms)) {
        if (arm.n > 0) out[recipe] = { n: arm.n, mean: arm.sum / arm.n }
      }
      if (Object.keys(out).length > 0) bandit[playerId] = out
    }
    if (Object.keys(bandit).length > 0) this.current.bandit = bandit
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

      case 'drop':
        if (ev.kind === 'heart') this.current.heartsDropped += 1
        break

      case 'pickup':
        bump(this.current.pickups, ev.kind)
        if (ev.kind === 'heart') {
          this.current.heartsTaken += 1
          this.current.heartHpSum += this.hpBefore.get(ev.id) ?? 1
        }
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

      case 'horde':
        this.current.hordes.push(ev.count)
        bump((this.current.recipes ??= {}), ev.recipe)
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
 * `ttk` — temps pour tuer le monstre de référence de l'étage, au DPS que le
 * joueur produit réellement. Directement comparable à TARGET_TTK.
 *
 *   Le DPS réel se lit sur les touches, jamais sur les coups portés : un joueur
 *   qui garde le clic enfoncé en traversant l'étage frappe deux à trois fois
 *   plus souvent qu'il ne touche, et compter les coups mesurerait sa discipline
 *   de gâchette plutôt que la solidité des monstres.
 *
 *   On rapporte ce DPS à un monstre **de référence** plutôt qu'à la moyenne de
 *   ce qui est mort. Diviser le temps de frappe par le nombre de morts donnait
 *   des valeurs ingérables : le gardien d'étage a 3.2× les PV d'un monstre
 *   normal, donc un étage où on tue peu mais où on tue le gardien affichait un
 *   TTK triplé sans que rien n'ait changé.
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
  const dealt = Object.values(f.damageDealt).reduce((a, b) => a + b, 0)

  let connectedSeconds = 0
  for (const [weaponId, n] of Object.entries(f.hits)) {
    const w = WEAPONS[weaponId]
    if (w) connectedSeconds += (n * w.cooldown) / TICK_RATE
  }

  const refHp = REFERENCE_SPECIES.maxHp * floorScale(f.floor, FLOOR_HP_GROWTH)
  const dps = connectedSeconds > 0 ? dealt / connectedSeconds : 0

  // `poolHp` manque sur les relevés d'avant le modèle de puissance : mieux vaut
  // ne rien afficher qu'un NaN qui ressemble à une mesure.
  const pool = f.poolHp ?? 0
  return {
    ttk: kills >= 3 && dps > 0 ? refHp / dps : null,
    k: kills >= 3 && taken > 0 && pool > 0 ? (pool * kills) / taken : null,
  }
}

/**
 * Ce que dit la distribution d'engagement : la difficulté d'un étage ne tient
 * pas au nombre de monstres qu'il contient mais au nombre qu'on affronte à la
 * fois. Un étage de quarante monstres pris un par un est un étage facile.
 */
export function engagement(f: FloorRecord): {
  /** Effectif médian, en ne comptant que les instants où on est engagé. */
  median: number
  /** Effectif dépassé 10 % du temps engagé : les vrais mauvais moments. */
  p90: number
  peak: number
  /** Part du temps engagé passée en tête-à-tête. Élevée = aucune décision à prendre. */
  soloShare: number
  /** Part du temps de l'étage passée sans aucun ennemi à portée. */
  idleShare: number
} | null {
  const hist = f.engaged
  if (!hist?.length) return null
  const total = hist.reduce((a, b) => a + b, 0)
  if (total === 0) return null

  const idle = hist[0] ?? 0
  const busy = total - idle
  if (busy === 0) return { median: 0, p90: 0, peak: 0, soloShare: 0, idleShare: 1 }

  const quantile = (q: number): number => {
    let seen = 0
    for (let n = 1; n < hist.length; n++) {
      seen += hist[n] ?? 0
      if (seen >= busy * q) return n
    }
    return hist.length - 1
  }
  let peak = 0
  for (let n = hist.length - 1; n >= 1; n--) {
    if ((hist[n] ?? 0) > 0) {
      peak = n
      break
    }
  }

  return {
    median: quantile(0.5),
    p90: quantile(0.9),
    peak,
    soloShare: (hist[1] ?? 0) / busy,
    idleShare: idle / total,
  }
}

/**
 * Ce que la Directrice a effectivement livré. Le nombre de vagues dit si elle a
 * trouvé des creux ; leur taille moyenne dit si elles pesaient quelque chose ;
 * `unspent` dit ce qu'elle n'a jamais réussi à placer, c'est-à-dire des
 * monstres que l'étage contenait sur le papier et que personne n'a rencontrés.
 */
export function waves(f: FloorRecord): {
  count: number
  mean: number
  biggest: number
  delivered: number
  unspent: number
} {
  const list = f.hordes ?? []
  const delivered = list.reduce((a, b) => a + b, 0)
  return {
    count: list.length,
    mean: list.length ? delivered / list.length : 0,
    biggest: list.reduce((a, b) => Math.max(a, b), 0),
    delivered,
    unspent: Math.max(0, (f.held ?? 0) + f.pursuers - delivered),
  }
}

export function floorSummary(f: FloorRecord): string {
  const seconds = (f.ticks / TICK_RATE).toFixed(0)
  const kills = Object.values(f.kills).reduce((a, b) => a + b, 0)
  const taken = Object.values(f.damageTaken).reduce((a, b) => a + b, 0)
  // Le total présent inclut la réserve : elle fait partie de l'étage même si
  // elle n'est pas sur la carte à l'arrivée. Sans elle, on lit « 12 tués sur 6 ».
  const present = f.spawned + f.pursuers + (f.held ?? 0)
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
