/**
 * Sauvegarde des parties sur disque.
 *
 * L'état d'un donjon fait quelques Ko : un fichier JSON par room suffit
 * largement pour 4 joueurs. Postgres deviendra utile le jour où on voudra de la
 * progression méta entre les parties, pas avant.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fromBase64, toBase64, type GameState } from '@dc/engine'

const DATA_DIR = process.env.DATA_DIR ?? './data'
const ROOMS_DIR = join(DATA_DIR, 'rooms')

/** Version du format : incrémenter si la forme de GameState change de façon incompatible. */
const SAVE_VERSION = 1

let ready: Promise<void> | null = null
function ensureDir(): Promise<void> {
  ready ??= mkdir(ROOMS_DIR, { recursive: true }).then(() => undefined)
  return ready
}

const fileFor = (code: string) => join(ROOMS_DIR, `${code}.json`)

export async function saveRoom(code: string, state: GameState): Promise<void> {
  await ensureDir()
  const payload = JSON.stringify({
    v: SAVE_VERSION,
    state: { ...state, tiles: toBase64(state.tiles) },
  })
  // Écriture atomique : on ne veut pas d'une sauvegarde tronquée si le
  // process meurt pendant un redéploiement Coolify.
  const tmp = `${fileFor(code)}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, fileFor(code))
}

export async function loadRoom(code: string): Promise<GameState | null> {
  try {
    const raw = await readFile(fileFor(code), 'utf8')
    const parsed = JSON.parse(raw) as { v?: number; state?: Record<string, unknown> }
    if (parsed.v !== SAVE_VERSION || !parsed.state) return null

    const s = parsed.state as unknown as GameState & { tiles: string }
    const state: GameState = { ...s, tiles: fromBase64(s.tiles) }

    // Personne n'est connecté au chargement : tout le monde est prêt à agir.
    for (const a of Object.values(state.actors)) a.readyAt = state.tick
    state.events = []
    return state
  } catch {
    return null
  }
}
