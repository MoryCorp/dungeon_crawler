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
import type { RunRecord } from './telemetry.js'

const DATA_DIR = process.env.DATA_DIR ?? './data'
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const RUNS_DIR = join(DATA_DIR, 'runs')

/**
 * Version du format : incrémenter si la forme de GameState change de façon
 * incompatible. Une sauvegarde d'une autre version est ignorée, et la partie
 * repart d'un donjon neuf — acceptable entre amis, et bien préférable à un
 * chargement d'état à moitié valide.
 *
 * 2 : projectiles, objets au sol, escalier verrouillé, armes et niveaux.
 */
const SAVE_VERSION = 2

let ready: Promise<void> | null = null
function ensureDir(): Promise<void> {
  ready ??= Promise.all([
    mkdir(ROOMS_DIR, { recursive: true }),
    mkdir(RUNS_DIR, { recursive: true }),
  ]).then(() => undefined)
  return ready
}

const fileFor = (code: string) => join(ROOMS_DIR, `${code}.json`)
const runFileFor = (code: string) => join(RUNS_DIR, `${code}.json`)

/** Écriture atomique : jamais de fichier tronqué si le process meurt. */
async function writeAtomic(path: string, payload: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, path)
}

export async function saveRoom(code: string, state: GameState): Promise<void> {
  await ensureDir()
  const payload = JSON.stringify({
    v: SAVE_VERSION,
    state: { ...state, tiles: toBase64(state.tiles) },
  })
  // On ne veut pas d'une sauvegarde tronquée si le process meurt pendant un
  // redéploiement Coolify.
  await writeAtomic(fileFor(code), payload)
}

/**
 * Les mesures de partie vivent dans leur propre fichier : elles n'ont pas la
 * même durée de vie que la sauvegarde (on veut pouvoir remettre le donjon à
 * zéro sans perdre l'historique qui sert à l'équilibrage) et elles n'ont
 * surtout pas besoin d'être rechargées pour jouer.
 */
export async function saveRun(code: string, run: RunRecord): Promise<void> {
  await ensureDir()
  await writeAtomic(runFileFor(code), JSON.stringify(run))
}

export async function loadRun(code: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await readFile(runFileFor(code), 'utf8')) as RunRecord
  } catch {
    return null
  }
}

export async function loadRoom(code: string): Promise<GameState | null> {
  try {
    const raw = await readFile(fileFor(code), 'utf8')
    const parsed = JSON.parse(raw) as { v?: number; state?: Record<string, unknown> }
    if (parsed.v !== SAVE_VERSION || !parsed.state) return null

    const s = parsed.state as unknown as GameState & { tiles: string }
    const state: GameState = { ...s, tiles: fromBase64(s.tiles) }

    // Personne n'est connecté au chargement : tout le monde est prêt à agir, et
    // aucun coup ne reste figé en cours de préparation.
    for (const a of Object.values(state.actors)) {
      a.readyAt = state.tick
      a.swingUntil = 0
      delete a.windupUntil
      delete a.dashUntil
    }
    state.projectiles = []
    state.events = []
    return state
  } catch {
    return null
  }
}
