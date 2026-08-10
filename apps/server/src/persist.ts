/**
 * Sauvegarde des parties sur disque.
 *
 * L'état d'un donjon fait quelques Ko : un fichier JSON par room suffit
 * largement pour 4 joueurs. Postgres deviendra utile le jour où on voudra de la
 * progression méta entre les parties, pas avant.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MONSTERS,
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
const SAVE_VERSION = 8

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

/**
 * Écriture atomique : jamais de fichier tronqué si le process meurt. Le nom
 * du fichier temporaire est unique par écriture — un `.tmp` fixe faisait que
 * deux écritures concurrentes s'écrasaient l'une l'autre à mi-course. En cas
 * d'échec, le temporaire est nettoyé au lieu de s'accumuler sur le disque.
 */
let writeSeq = 0
async function writeAtomic(path: string, payload: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${writeSeq++}.tmp`
  try {
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

export async function saveRoom(
  code: string,
  state: GameState,
  resets = 0,
  /**
   * Une descente neuve est due mais n'a pas encore eu lieu : l'équipe vient de
   * tomber et l'écran de fin s'affiche. L'instant du redémarrage ne se
   * sérialise pas — c'est une heure murale, elle ne veut plus rien dire à la
   * relecture. Le drapeau, lui, suffit : au chargement on repart neuf.
   */
  pendingReset = false,
): Promise<void> {
  // Sérialisé AVANT toute attente : `ensureDir` fait de l'I/O réelle à son
  // tout premier appel, et des ticks passent pendant ce temps — l'état écrit
  // ne serait plus celui que l'appelant a capturé.
  // `resets` voyage avec l'état : sans lui, un redémarrage du process
  // repartait du compteur zéro et la room rejouait la graine de sa toute
  // première run. Champ additif, pas de changement de version.
  // `events` reste dehors : c'est le transitoire du tick en cours, il est
  // remis à zéro au tick suivant et ne veut rien dire rechargé.
  const payload = JSON.stringify({
    v: SAVE_VERSION,
    resets,
    ...(pendingReset ? { pendingReset: true } : {}),
    state: { ...state, events: [], tiles: toBase64(state.tiles) },
  })
  await ensureDir()
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

/**
 * Un relevé n'est pas un état de jeu : c'est une mesure. Le perdre coûte des
 * chiffres d'équilibrage, alors que le croire sur parole coûtait la partie —
 * un `floors` non itérable faisait lever le constructeur de la télémétrie,
 * rejeter le chargement de la room, et le `join` échouait.
 */
function plausibleRun(r: unknown): r is RunRecord {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  if (!Array.isArray(x.floors)) return false
  if (!x.floors.every((f) => typeof f === 'object' && f !== null &&
    Number.isFinite((f as Record<string, unknown>).floor))) return false
  for (const k of ['wipes', 'runs', 'seed'] as const) {
    if (x[k] !== undefined && !Number.isFinite(x[k])) return false
  }
  return true
}

export async function loadRun(code: string): Promise<RunRecord | null> {
  let raw: string
  try {
    raw = await readFile(runFileFor(code), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await quarantine(runFileFor(code), `[run ${code}]`, 'illisible (JSON invalide)')
    return null
  }
  if (!plausibleRun(parsed)) {
    // La quarantaine compte double ici : `saveRun` réécrit toutes les dix
    // secondes, sans renommage la preuve serait détruite avant qu'on la voie.
    await quarantine(runFileFor(code), `[run ${code}]`, 'incohérent (structure inattendue)')
    return null
  }
  return parsed
}

export interface LoadedRoom {
  /**
   * L'état sauvegardé, ou `null` quand la sauvegarde décrit une partie dont la
   * descente neuve était due : il n'y a rien à reprendre, seulement un
   * compteur de runs à faire avancer.
   */
  state: GameState | null
  /** Runs relancées dans cette room — repris pour ne pas rejouer une graine. */
  resets: number
}

/**
 * Un fichier qui existe mais ne se relit pas est mis de côté plutôt
 * qu'écrasé : la partie repart neuve, et le fichier reste là pour l'autopsie.
 * Sans ça, la prochaine sauvegarde détruisait la seule preuve.
 */
async function quarantine(path: string, who: string, why: string): Promise<void> {
  const dest = `${path}.corrupt-${Date.now()}`
  try {
    await rename(path, dest)
    console.error(`${who} fichier ${why} — mis en quarantaine : ${dest}`)
  } catch (err) {
    console.error(`${who} fichier ${why}, quarantaine impossible :`, err)
  }
}

/** Les phases du piège, énumérées ici pour que l'oubli d'une se voie. */
const TRAP_PHASES: string[] = ['armed', 'warning', 'sprung', 'done']
const SCENES: string[] = ['entree', 'sas', 'boss']

const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const point = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  finite((v as Record<string, unknown>).x) && finite((v as Record<string, unknown>).y)

/**
 * Un acteur relu doit pouvoir être joué. Une espèce absente du bestiaire est
 * le mode de panne le plus probable — un monstre retiré entre deux versions —
 * et il ne se voit qu'au premier tick, quand `MONSTERS[species]` rend
 * `undefined` et que tout ce qui suit s'écroule.
 */
function plausibleActor(key: string, a: unknown): boolean {
  if (typeof a !== 'object' || a === null) return false
  const r = a as Record<string, unknown>
  if (r.id !== key) return false
  if (r.kind !== 'player' && r.kind !== 'monster') return false
  if (typeof r.species !== 'string' || r.species === '') return false
  if (r.kind === 'monster' && !MONSTERS[r.species]) return false
  if (typeof r.alive !== 'boolean') return false
  return finite(r.x) && finite(r.y) && finite(r.hp) && finite(r.maxHp)
}

/**
 * Ce qu'une sauvegarde doit porter pour que le premier tick tienne debout.
 *
 * La ligne de partage avec les valeurs par défaut plus bas : un défaut n'est
 * légitime que si l'absence du champ a une valeur **neutre et vraie**. C'est
 * le cas des champs ajoutés après coup — un fichier écrit avant leur
 * existence dit la vérité en ne les portant pas (une bourse absente est une
 * bourse vide). Un champ que tout écrivain de la version courante émet ne
 * peut pas manquer sans rendre le fichier suspect en entier : lui inventer
 * une valeur fabriquerait un état FAUX et effacerait la preuve. Celui-là part
 * en quarantaine.
 *
 * Rend le nom du premier champ fautif, ou `null` si tout va bien : la
 * quarantaine ne sert à rien si elle ne dit pas de quoi le fichier est mort.
 */
function stateFault(s: unknown): string | null {
  if (typeof s !== 'object' || s === null) return 'état'
  const r = s as Record<string, unknown>
  if (!finite(r.width) || (r.width as number) <= 0) return 'width'
  if (!finite(r.height) || (r.height as number) <= 0) return 'height'
  if (typeof r.tiles !== 'string') return 'tiles'
  if (!finite(r.floor)) return 'floor'
  if (!finite(r.tick)) return 'tick'
  if (!finite(r.seed)) return 'seed'
  // Un `nextId` non numérique ne plante pas : il fabrique des identifiants
  // « iNaN » qui se marchent dessus. Une corruption silencieuse est pire
  // qu'un plantage, elle mérite la même quarantaine.
  if (!finite(r.rng)) return 'rng'
  if (!finite(r.nextId)) return 'nextId'
  if (!Array.isArray(r.items)) return 'items'
  if (!point(r.stairs)) return 'stairs'
  if (!point(r.spawn)) return 'spawn'
  // Un défaut `false` ouvrirait l'escalier sans la clé du gardien : c'est
  // exactement l'état faux que la règle interdit d'inventer.
  if (typeof r.stairsLocked !== 'boolean') return 'stairsLocked'
  if (typeof r.actors !== 'object' || r.actors === null || Array.isArray(r.actors)) return 'actors'
  for (const [key, a] of Object.entries(r.actors as Record<string, unknown>)) {
    if (!plausibleActor(key, a)) return `actors.${key}`
  }
  // Optionnels : légitimement absents. Les exiger mettrait en quarantaine la
  // quasi-totalité des sauvegardes — tout étage ordinaire est sans scène et
  // sans salle piégée. On ne les valide que s'ils sont là.
  if (r.scene !== undefined && !SCENES.includes(r.scene as string)) return 'scene'
  if (r.trap !== undefined) {
    const t = r.trap as Record<string, unknown>
    if (typeof t !== 'object' || t === null) return 'trap'
    if (!TRAP_PHASES.includes(t.phase as string)) return 'trap.phase'
    if (!Array.isArray(t.gates)) return 'trap.gates'
  }
  // `projectiles`, `events` et `banditPending` ne sont pas validés : ils sont
  // vidés ou supprimés à la relecture, plus bas. Ne pas les ajouter ici par
  // symétrie — ce serait rejeter un fichier pour un champ qu'on jette.
  return null
}

export async function loadRoom(code: string): Promise<LoadedRoom | null> {
  // Quatre façons d'échouer, quatre réponses. Absent : partie neuve, en
  // silence. Version d'avant : partie neuve, en le disant. Illisible ou
  // incohérent : quarantaine, puis partie neuve. Erreur d'I/O : on le dit
  // aussi — un disque plein ne doit pas se déguiser en « pas de sauvegarde ».
  let raw: string
  try {
    raw = await readFile(fileFor(code), 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') {
      console.error(`[room ${code}] lecture de la sauvegarde impossible (${e.code}) :`, e.message)
    }
    return null
  }
  try {
    let parsed: { v?: number; resets?: number; pendingReset?: boolean; state?: unknown }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      await quarantine(fileFor(code), `[room ${code}]`, 'illisible (JSON invalide)')
      return null
    }
    if (parsed.v !== SAVE_VERSION) {
      console.log(`[room ${code}] sauvegarde v${parsed.v ?? '?'} ignorée (format v${SAVE_VERSION})`)
      return null
    }
    const fault = stateFault(parsed.state)
    if (fault !== null) {
      await quarantine(fileFor(code), `[room ${code}]`, `incohérent (${fault})`)
      return null
    }

    const s = parsed.state as GameState & { tiles: string }
    // Le drapeau n'est lu qu'APRÈS validation : on ne fait pas confiance à un
    // marqueur venu d'un fichier dont on n'a pas vérifié le reste.
    if (parsed.pendingReset === true) {
      console.log(`[room ${code}] wipe interrompu par un arrêt — descente neuve`)
      // L'index de run avance ici, là où l'on sait pourquoi : la run morte est
      // finie, celle qui vient est la suivante, et elle ne rejouera pas sa
      // graine.
      return { state: null, resets: (parsed.resets ?? 0) + 1 }
    }

    const state: GameState = { ...s, tiles: fromBase64(s.tiles) }
    if (state.tiles.length !== state.width * state.height) {
      await quarantine(fileFor(code), `[room ${code}]`, 'incohérent (carte tronquée)')
      return null
    }

    // Personne n'est connecté au chargement : tout le monde est prêt à agir, et
    // aucun coup ne reste figé en cours de préparation.
    for (const a of Object.values(state.actors)) {
      a.readyAt = state.tick
      a.swingUntil = 0
      delete a.windupUntil
      delete a.dashUntil
      delete a.pendingAttack
      // On reprend le souffle plein : personne n'a couru depuis des jours.
      // Et personne n'est là : chaque personnage attend son joueur dans les
      // limbes, c'est le `join` qui le fera revenir au monde. Sans ça, le
      // premier connecté jouait entouré des corps ciblables de ses amis.
      if (a.kind === 'player') {
        a.stamina = 1
        a.sprinting = false
        a.sprintedAt = state.tick - SPRINT_REFILL_DELAY
        a.offline = true
        // Le compte à rebours de l'oubli repart d'ici : un personnage chargé
        // n'a pas d'absence mesurable derrière lui, et on ne va pas l'effacer
        // au premier escalier sous prétexte que la sauvegarde dormait.
        a.offlineAt = state.tick
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
    // Le décor est purement visuel : son absence est neutre et vraie, un étage
    // sans mobilier se joue exactement pareil.
    state.decor ??= []
    // Chantier 4, tout additif : bourse de plafond, usure, salle de repos.
    state.capBonus ??= 0
    state.capBought ??= 0
    state.wear ??= { lowTicks: 0, ticks: 0, downs: 0 }
    // La Directrice repart d'une ardoise propre : son intensité mesure ce que le
    // joueur vient de vivre, et il ne vient de rien vivre du tout. Recharger un
    // pic vieux de trois jours livrerait une vague sur un donjon endormi.
    state.director = createDirector(state.tick, state.seed)
    return { state, resets: parsed.resets ?? 0 }
  } catch (err) {
    // Filet de sécurité : une sauvegarde qui explose à la reconstitution est
    // une sauvegarde corrompue, même si elle avait l'air plausible.
    console.error(`[room ${code}] reconstitution de la sauvegarde échouée :`, err)
    await quarantine(fileFor(code), `[room ${code}]`, 'incohérent (reconstitution échouée)')
    return null
  }
}
