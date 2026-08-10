/**
 * Validation des messages entrants.
 *
 * Le cast `JSON.parse(...) as ClientMsg` faisait confiance au réseau : un
 * client bricolé pouvait envoyer `mx: 1e308`, `aim: NaN` ou un `input` qui
 * n'en est pas un, et tout ça entrait tel quel dans la simulation — un NaN
 * dans une position se propage à tout ce qu'il touche. Ici, rien ne passe
 * qui ne soit exactement de la forme attendue, et tout le reste compte comme
 * une violation : au bout de dix, la socket est fermée.
 */
import type { ClientMsg, PlayerInput } from '@dc/engine'

/** Un message de jeu tient en quelques centaines d'octets ; 2 Ko est déjà large. */
export const MAX_MSG_BYTES = 2048
/** Violations tolérées avant de fermer la socket : un bug honnête, pas un flot. */
export const MAX_VIOLATIONS = 10

const clampAxis = (v: number): number => Math.max(-1, Math.min(1, v))

/**
 * Un `PlayerInput` sain ou rien. Les axes sont bornés à [-1, 1] — la vitesse
 * est décidée par le moteur, pas par le client — et les impulsions sont des
 * booléens stricts : `"true"`, `1` ou un objet ne déclenchent rien.
 */
export function sanitizeInput(raw: unknown): PlayerInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const mx = r.mx
  const my = r.my
  const aim = r.aim
  if (typeof mx !== 'number' || !Number.isFinite(mx)) return null
  if (typeof my !== 'number' || !Number.isFinite(my)) return null
  if (typeof aim !== 'number' || !Number.isFinite(aim)) return null
  const input: PlayerInput = {
    mx: clampAxis(mx),
    my: clampAxis(my),
    aim,
    attack: r.attack === true,
    sprint: r.sprint === true,
  }
  if (r.drink === true) input.drink = true
  if (r.roll === true) input.roll = true
  if (r.take === true) input.take = true
  return input
}

/** Un `ClientMsg` sain ou rien — jamais un objet à moitié conforme. */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MSG_BYTES) return null
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>

  switch (m.t) {
    case 'ping':
      // `ts` repart tel quel dans le pong : on exige un nombre fini pour ne
      // pas servir de miroir à n'importe quoi.
      return typeof m.ts === 'number' && Number.isFinite(m.ts)
        ? { t: 'ping', ts: m.ts }
        : null
    case 'join': {
      if (typeof m.room !== 'string') return null
      const name = typeof m.name === 'string' ? m.name : ''
      return { t: 'join', room: m.room, name }
    }
    case 'input': {
      const input = sanitizeInput(m.input)
      return input ? { t: 'input', input } : null
    }
    default:
      return null
  }
}
