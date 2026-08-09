/**
 * Sauvegarde des parties sur disque.
 *
 * L'état d'un donjon fait quelques Ko : un fichier JSON par room suffit
 * largement pour 4 joueurs. Postgres deviendra utile le jour où on voudra de la
 * progression méta entre les parties, pas avant.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SPRINT_REFILL_DELAY,
  createDirector,
  fromBase64,
  toBase64,
  type GameState,
} from '@dc/engine'
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
 * 3 : modèle de puissance multiplicatif. Un personnage sauvegardé sous
 *     l'ancien modèle porte des PV et une attaque additifs qui ne veulent plus
 *     rien dire — au niveau 24 il aurait 147 PV là où la formule en donne 98,
 *     et le premier passage de niveau lui en retirerait cinquante d'un coup.
 *     Repartir d'un donjon neuf est la seule reprise honnête.
 * 4 : la Directrice. Un étage sauvegardé sous l'ancien format a déjà tous ses
 *     monstres posés sur la carte et pas de réserve : le rechargement donnerait
 *     un étage que la Directrice ne peut plus animer, donc plus aucune vague
 *     jusqu'à l'escalier suivant.
 * 5 : profils de style et recettes de vagues. La réserve devient un compteur —
 *     une réserve v4 pré-tirée en espèces ne peut plus être livrée par recette,
 *     et un profil absent fausserait la future adaptation : donjon neuf.
 *
 * Le sprint et l'interruption des préparations n'ont pas demandé de version :
 * ils n'ajoutent que des champs optionnels, qu'une valeur par défaut suffit à
 * reconstituer plus bas. On ne casse une sauvegarde que quand la relire donne
 * un état faux, jamais quand elle est seulement incomplète.
 */
// v7 : les actes et leurs biomes — un étage sauvegardé en v6 rejouerait le
// mauvais peuplement (garnison du Château absente, SAS d'entrée d'acte
// manquant) sur un décor qui ne correspond plus.
const SAVE_VERSION = 7

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
      // On reprend le souffle plein : personne n'a couru depuis des jours.
      if (a.kind === 'player') {
        a.stamina = 1
        a.sprinting = false
        a.sprintedAt = state.tick - SPRINT_REFILL_DELAY
      }
      delete a.staggerReadyAt
      // Les effets de fiole sont transitoires ; la fiole portée, elle, reste.
      delete a.hasteUntil
      delete a.freshUntil
      // Une escouade décrit une approche en cours. Après un redéploiement, il
      // n'y a plus d'approche : chacun repart pour soi.
      delete a.squad
      delete a.squadUntil
    }
    state.projectiles = []
    state.events = []
    state.pursuers ??= []
    state.reserveCount ??= 0
    state.profiles ??= {}
    state.bandit ??= {}
    // Une fenêtre d'évaluation en cours au moment de l'arrêt ne veut plus rien
    // dire au rechargement : la vague qu'elle mesurait n'existe plus.
    delete state.banditPending
    state.floorKills ??= 0
    // Les ossements sont additifs : une bourse absente est une bourse vide,
    // pas un état faux — pas de changement de version pour ça.
    state.bones ??= 0
    // Salles typées : une sauvegarde d'avant n'en a pas. L'étage courant se
    // joue alors « tout couloir » pour les recettes, le suivant sera typé.
    state.rooms ??= []
    // Chantier 4, tout additif : bourse de plafond, usure, salle de repos.
    state.capBonus ??= 0
    state.capBought ??= 0
    state.wear ??= { lowTicks: 0, ticks: 0, downs: 0 }
    // La Directrice repart d'une ardoise propre : son intensité mesure ce que le
    // joueur vient de vivre, et il ne vient de rien vivre du tout. Recharger un
    // pic vieux de trois jours livrerait une vague sur un donjon endormi.
    state.director = createDirector(state.tick, state.seed)
    return state
  } catch {
    return null
  }
}
