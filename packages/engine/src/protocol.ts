/**
 * Protocole réseau, partagé par le client et le serveur.
 *
 * Choix de conception : le brouillard est *commun à l'équipe* (union des champs
 * de vision). Une seule sérialisation par tick sert donc les 4 joueurs, et voir
 * ce que voit un coéquipier est un vrai atout de coopération.
 *
 * Corollaire assumé : la carte complète est envoyée au client, donc le
 * brouillard est cosmétique et un client modifié pourrait tout révéler. Sans
 * importance pour une partie entre amis ; si ça devient un sujet, il suffit de
 * n'envoyer que les tuiles explorées.
 */
import type { Actor, Dir, GameEvent, GameState, Intent } from './types.js'

const g = globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } }

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
    // Copie volontaire : Buffer.from alloue dans un pool partagé, et on ne veut
    // pas qu'écrire dans les tuiles d'une partie corrompe une autre.
    return new Uint8Array((globalThis as any).Buffer.from(s, 'base64') as Uint8Array)
  }
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Compacte un tableau de 0/1 en bitset : 4096 cases -> 512 octets (~684 en base64). */
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
  facing: Dir
  alive: boolean
  /** Faux pour un coéquipier hors du champ de vision (affiché en marqueur). */
  visible: boolean
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string }
  | { t: 'intent'; intent: Intent | null }
  | { t: 'ping'; ts: number }

export type ServerMsg =
  | { t: 'welcome'; selfId: string; room: string; tickRate: number }
  | { t: 'floor'; floor: number; width: number; height: number; tiles: string }
  | { t: 'state'; tick: number; floor: number; actors: ActorView[]; vis: string; events: GameEvent[] }
  | { t: 'pong'; ts: number }
  | { t: 'error'; msg: string }

export function buildActorViews(state: GameState, visible: Uint8Array): ActorView[] {
  const out: ActorView[] = []
  for (const a of Object.values(state.actors)) {
    const seen = visible[a.y * state.width + a.x] === 1
    // Les joueurs sont toujours transmis (position de l'équipe sur la carte),
    // les monstres uniquement s'ils sont dans le champ de vision de l'équipe.
    if (a.kind === 'monster' && !seen) continue
    out.push({
      id: a.id,
      kind: a.kind,
      species: a.species,
      name: a.name,
      x: a.x,
      y: a.y,
      hp: a.hp,
      maxHp: a.maxHp,
      facing: a.facing,
      alive: a.alive,
      visible: seen,
    })
  }
  return out
}
