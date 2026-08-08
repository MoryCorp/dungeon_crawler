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
import type { Actor, GameEvent, GameState, PlayerInput } from './types.js'

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
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string }
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; ts: number }

export type ServerMsg =
  | { t: 'welcome'; selfId: string; room: string; tickRate: number }
  | { t: 'floor'; floor: number; width: number; height: number; tiles: string }
  | {
      t: 'state'
      tick: number
      floor: number
      actors: ActorView[]
      /** Absent sur la plupart des paquets : le brouillard bouge lentement. */
      vis?: string
      events: GameEvent[]
    }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string }

/** Deux décimales suffisent : un centième de tuile fait un sixième de pixel à l'écran. */
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

export function buildActorViews(state: GameState, visible: Uint8Array): ActorView[] {
  const out: ActorView[] = []
  for (const a of Object.values(state.actors)) {
    const tx = Math.min(state.width - 1, Math.max(0, Math.floor(a.x)))
    const ty = Math.min(state.height - 1, Math.max(0, Math.floor(a.y)))
    const seen = visible[ty * state.width + tx] === 1
    if (a.kind === 'monster' && !seen) continue

    out.push({
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
    })
  }
  return out
}
