/**
 * Protocole réseau, partagé par le client et le serveur.
 *
 * Le brouillard est commun à l'équipe (union des champs de vision), donc une
 * seule sérialisation par tick sert les 4 joueurs. Voir ce que voit un
 * coéquipier est un atout de coopération, pas une fuite d'information.
 *
 * Corollaire assumé : la carte complète est envoyée au client, le brouillard
 * est donc cosmétique. Sans importance entre amis.
 */
import type { Decor, Room } from './mapgen.js'
import type { Actor, GameEvent, GameState, ItemKind, PlayerInput } from './types.js'
import { MONSTERS, MONSTER_HALF_ARC, TICK_RATE, healCapOf, xpForLevel } from './types.js'

const g = globalThis as unknown as {
  Buffer?: { from(b: Uint8Array | string, enc?: string): Uint8Array & { toString(e: string): string } }
}

export function toBase64(bytes: Uint8Array): string {
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64')
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function fromBase64(s: string): Uint8Array {
  if (g.Buffer) {
    // Copie volontaire : Buffer.from alloue dans un pool partagé.
    return new Uint8Array(g.Buffer.from(s, 'base64'))
  }
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Compacte un tableau de 0/1 en bitset : 4096 cases -> 512 octets. */
export function packBits(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array((flags.length + 7) >> 3)
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) out[i >> 3]! |= 1 << (i & 7)
  }
  return out
}

export function unpackBits(packed: Uint8Array, length: number, out?: Uint8Array): Uint8Array {
  const res = out && out.length === length ? out : new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    res[i] = (packed[i >> 3]! >> (i & 7)) & 1
  }
  return res
}

export interface ActorView {
  id: string
  kind: Actor['kind']
  species: string
  name: string
  x: number
  y: number
  hp: number
  maxHp: number
  aim: number
  alive: boolean
  /** Faux pour un coéquipier hors du champ de vision (affiché en marqueur). */
  visible: boolean
  /** Coup en cours : le client dessine l'arc. */
  swinging: boolean
  /** Coup en préparation : le client dessine le télégraphe à esquiver. */
  winding: boolean
  invuln: boolean

  /** Joueurs uniquement. */
  weapon?: string
  level?: number
  xp?: number
  /** XP cumulée nécessaire pour le niveau suivant : évite de dupliquer la courbe côté client. */
  xpNext?: number
  downed?: boolean
  /** Déconnecté : le personnage attend son joueur — rendu estompé. */
  offline?: boolean
  /** Progression de la relève, 0 à 1. */
  revive?: number
  /** Jauge de sprint, 0 à 1. Le client la redescend entre deux paquets. */
  stamina?: number
  /** Fiole portée dans la fente d'inventaire. */
  potion?: string
  /** Fiole de vitesse active : le client prédit le déplacement accéléré. */
  hasted?: boolean
  /** Roulade en cours : le rendu incline le sprite et laisse une traînée. */
  rolling?: boolean
  /**
   * Plafond de soin en PV : au-dessus, les cœurs restent au sol. Le client
   * l'affiche — un soin qu'on refuse sans le dire ressemble à un bug.
   */
  hpCeil?: number

  /** Monstres uniquement. */
  rank?: 'elite' | 'boss'
  dashing?: boolean
  /**
   * Géométrie exacte du coup en préparation, calculée par le serveur qui
   * seul connaît le pattern figé. Le client la dessine telle quelle — avant,
   * il la déduisait de l'espèce et mentait sur les deux patterns du colosse.
   */
  telegraphReach?: number
  telegraphHalfArc?: number
}

export interface ProjectileView {
  id: string
  x: number
  y: number
  color: number
  hostile: boolean
}

export interface ItemView {
  id: string
  kind: ItemKind
  x: number
  y: number
  weapon?: string
  /** Prix en ossements, pour l'étiquette au-dessus de l'objet. */
  price?: number
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string }
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; ts: number }

export type ServerMsg =
  | { t: 'welcome'; selfId: string; room: string; tickRate: number }
  | {
      t: 'floor'
      floor: number
      width: number
      height: number
      tiles: string
      /** Décor visuel de l'étage — envoyé une fois, peint dans la carte. */
      decor?: Decor[]
      /** Les salles : le client habille chacune de son matériau de sol. */
      rooms?: Room[]
      /** Palier de boss : sanctuaire marchand ou arène du Gardien. */
      scene?: 'sas' | 'boss'
    }
  /** Équipe au tapis : écran bref côté client, le serveur relance une descente
   *  neuve dans la même room quelques secondes plus tard. */
  | { t: 'gameover'; floor: number }
  | {
      t: 'state'
      tick: number
      floor: number
      actors: ActorView[]
      projectiles: ProjectileView[]
      items: ItemView[]
      /** L'escalier reste fermé tant que la clé du gardien n'est pas prise. */
      locked: boolean
      /**
       * Monstres de l'étage précédent pas encore sortis de l'escalier. Le joueur
       * doit le savoir : une menace qu'on ne peut pas anticiper n'est pas de la
       * difficulté, c'est une embuscade gratuite.
       */
      chasing: number
      /** Absent sur la plupart des paquets : le brouillard bouge lentement. */
      vis?: string
      /**
       * Intensité de la Directrice, 0 à 1. Le client ne s'en sert que pour la
       * musique : la bande-son est pilotée par le même signal que les vagues.
       */
      intensity?: number
      /** Bourse d'équipe : les ossements ramassés, pas encore dépensés. */
      bones: number
      events: GameEvent[]
    }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string }

/** Deux décimales suffisent : un centième de tuile fait un sixième de pixel à l'écran. */
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Une position est-elle dans le champ de vision de l'équipe ? */
function seenAt(state: GameState, visible: Uint8Array, x: number, y: number): boolean {
  const tx = Math.min(state.width - 1, Math.max(0, Math.floor(x)))
  const ty = Math.min(state.height - 1, Math.max(0, Math.floor(y)))
  return visible[ty * state.width + tx] === 1
}

export function buildActorViews(state: GameState, visible: Uint8Array): ActorView[] {
  const out: ActorView[] = []
  for (const a of Object.values(state.actors)) {
    const seen = seenAt(state, visible, a.x, a.y)
    if (a.kind === 'monster' && !seen) continue

    const view: ActorView = {
      id: a.id,
      kind: a.kind,
      species: a.species,
      name: a.name,
      x: round2(a.x),
      y: round2(a.y),
      hp: a.hp,
      maxHp: a.maxHp,
      aim: round3(a.aim),
      alive: a.alive,
      visible: seen,
      swinging: a.swingUntil > state.tick,
      winding: a.windupUntil !== undefined && a.windupUntil > state.tick,
      invuln: a.invulnUntil !== undefined && a.invulnUntil > state.tick,
    }

    if (a.kind === 'player') {
      const level = a.level ?? 1
      view.weapon = a.weapon
      view.level = level
      view.xp = a.xp ?? 0
      view.xpNext = xpForLevel(level + 1)
      view.downed = a.downed === true
      if (a.offline) view.offline = true
      view.stamina = round2(a.stamina ?? 1)
      if (a.downed) view.revive = round2(a.reviveProgress ?? 0)
      if (a.potion !== undefined) view.potion = a.potion
      if ((a.hasteUntil ?? 0) > state.tick) view.hasted = true
      if (a.rollUntil !== undefined && a.rollUntil > state.tick) view.rolling = true
      view.hpCeil = Math.round(a.maxHp * healCapOf(state))
    } else {
      if (a.boss) view.rank = 'boss'
      else if (a.elite) view.rank = 'elite'
      if (a.dashUntil !== undefined && a.dashUntil > state.tick) view.dashing = true
      if (view.winding) {
        const def = MONSTERS[a.species]
        if (def) {
          const charging =
            def.behavior === 'charger' ||
            (def.behavior === 'colosse' && a.pendingAttack === 'charge')
          if (charging) {
            // Un couloir : la ruée blesse sur sa trajectoire, pas en arc.
            view.telegraphReach =
              round2(((def.dashSpeed ?? 10) * (def.dashTicks ?? 12)) / TICK_RATE)
            view.telegraphHalfArc = 0.16
          } else if (def.behavior === 'colosse') {
            // Le martèlement : l'arc court du marteau, pas la portée de charge.
            view.telegraphReach = 1.7
            view.telegraphHalfArc = round3(MONSTER_HALF_ARC)
          } else {
            view.telegraphReach = round2(def.reach)
            view.telegraphHalfArc = round3(MONSTER_HALF_ARC)
          }
        }
      }
    }

    out.push(view)
  }
  return out
}

export function buildProjectileViews(state: GameState, visible: Uint8Array): ProjectileView[] {
  const out: ProjectileView[] = []
  for (const p of state.projectiles) {
    if (!seenAt(state, visible, p.x, p.y)) continue
    out.push({
      id: p.id,
      x: round2(p.x),
      y: round2(p.y),
      color: p.color,
      hostile: p.hostileToPlayers,
    })
  }
  return out
}

export function buildItemViews(state: GameState, visible: Uint8Array): ItemView[] {
  const out: ItemView[] = []
  for (const item of state.items) {
    // Un coffre dans une pièce non éclairée reste une découverte à faire.
    if (!seenAt(state, visible, item.x, item.y)) continue
    out.push({
      id: item.id,
      kind: item.kind,
      x: round2(item.x),
      y: round2(item.y),
      weapon: item.weapon,
      ...(item.price !== undefined ? { price: item.price } : {}),
    })
  }
  return out
}
