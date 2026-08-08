/**
 * La Directrice — pilotage de l'intensité.
 *
 * Le modèle vient de l'IA Directrice de Left 4 Dead (2008), et il répond à une
 * demande précise : du stress en permanence, mais **juste**. La réponse n'est
 * pas une rampe de difficulté croissante, c'est une **onde** :
 *
 *   montée → pic → décompression → repos → montée…
 *
 * Une pression constante n'est pas de la difficulté, c'est de l'épuisement : au
 * bout de quelques minutes le joueur ne la perçoit plus, elle devient un bruit
 * de fond. C'est le creux qui donne sa valeur au pic. Et c'est le repos qui
 * permet de replacer un pic sans que ce soit vécu comme une punition.
 *
 * Ce module ne fait pas apparaître de monstres et ne connaît pas la carte : il
 * mesure une intensité perçue et rend une décision. Le placement est du ressort
 * de `game.ts`. Cette séparation n'est pas cosmétique — elle permet de tester la
 * politique sans donjon, et elle empêche la Directrice de devenir un second
 * moteur de jeu.
 *
 * Ce qu'elle corrige, mesuré sur de vraies parties : l'effectif médian des
 * rencontres valait **1**, et les deux tiers du temps de combat se passaient en
 * tête-à-tête. Les meutes posées sur la carte s'étiraient pendant l'approche et
 * se présentaient en file indienne. Une Directrice ne place pas les monstres,
 * elle les **livre** — groupés, d'un coup, au moment où il ne se passe rien.
 */
import {
  DIRECTOR_CALM,
  DIRECTOR_DECAY,
  DIRECTOR_FADE_MAX,
  DIRECTOR_PATIENCE,
  DIRECTOR_PEAK,
  DIRECTOR_PEAK_HOLD,
  DIRECTOR_REST,
  HORDE_MAX,
  HORDE_MIN,
  INTENSITY_DOWNED,
  INTENSITY_PER_DAMAGE,
  PRESENCE_WEIGHT,
  type DirectorState,
} from './types.js'

export function createDirector(tick: number, seed = 0): DirectorState {
  return { phase: 'buildup', intensity: 0, since: tick, seed: seed >>> 0 }
}

/** Ce que la Directrice observe à chaque tick. */
export interface Pressure {
  /** Fraction des PV max perdue par le joueur le plus touché, ce tick. */
  damageFraction: number
  /** Ennemis à portée d'engagement du joueur le plus exposé. */
  engaged: number
  /** Un joueur vient-il de tomber ? C'est le pic d'intensité le plus fort. */
  downed: boolean
  /** Reste-t-il de quoi livrer ? Sinon la Directrice ne peut que patienter. */
  available: number
}

/**
 * Met à jour l'intensité et la phase, et rend le nombre de monstres à livrer
 * maintenant — zéro la plupart du temps.
 *
 * Deux grandeurs, et il ne faut pas les confondre. L'**intensité** est une
 * mémoire : ce qu'on vient de subir, qui s'amortit toute seule. La **pression**
 * est ce que le joueur ressent à l'instant : la mémoire plus les ennemis qui
 * sont là, maintenant. C'est la pression qui décide des phases et des
 * livraisons ; l'intensité ne fait que se souvenir.
 *
 * Les avoir fusionnées était le défaut de fond : un monstre présent laissait
 * une trace de plusieurs secondes après sa mort, et surtout n'arrêtait jamais
 * d'en ajouter tant qu'il vivait. Un joueur qui recule pour souffler voit
 * maintenant la pression retomber au rythme où il décroche, ce qui est le seul
 * comportement lisible : la prudence doit payer tout de suite.
 */
export function updateDirector(
  director: DirectorState,
  tick: number,
  p: Pressure,
): number {
  director.intensity *= DIRECTOR_DECAY
  director.intensity += p.damageFraction * INTENSITY_PER_DAMAGE
  if (p.downed) director.intensity += INTENSITY_DOWNED
  director.intensity = Math.max(0, Math.min(1, director.intensity))

  const pressure = Math.min(1, director.intensity + p.engaged * PRESENCE_WEIGHT)
  const elapsed = tick - director.since
  const enter = (phase: DirectorState['phase']): void => {
    director.phase = phase
    director.since = tick
  }

  switch (director.phase) {
    case 'buildup': {
      if (pressure >= DIRECTOR_PEAK) {
        enter('peak')
        return 0
      }
      // On ne livre que si le calme dure. Livrer sur un creux d'une seconde
      // reviendrait à une pression continue, c'est-à-dire à pas de pic du tout.
      if (pressure < DIRECTOR_CALM && elapsed >= DIRECTOR_PATIENCE && p.available > 0) {
        director.since = tick
        const size = HORDE_MIN + Math.floor((HORDE_MAX - HORDE_MIN + 1) * pick(tick, director.seed))
        return Math.min(p.available, size)
      }
      return 0
    }

    case 'peak':
      // On tient le pic un court moment, sans rien ajouter : le joueur doit
      // avoir le temps de comprendre ce qui lui arrive et d'y répondre.
      if (elapsed >= DIRECTOR_PEAK_HOLD) enter('fade')
      return 0

    case 'fade':
      // Décompression : on attend que ça redescende vraiment — mais pas
      // indéfiniment. Sans la borne de temps, une salle qui ne se vide pas
      // fige la Directrice pour le reste de l'étage.
      if (pressure <= DIRECTOR_CALM || elapsed >= DIRECTOR_FADE_MAX) enter('rest')
      return 0

    case 'rest':
      // Repos garanti. Rien ne peut le raccourcir — c'est le creux qui donne
      // sa valeur au pic suivant.
      if (elapsed >= DIRECTOR_REST) enter('buildup')
      return 0
  }
}

/**
 * Variation déterministe issue du tick et de la graine de la partie.
 *
 * La Directrice ne **consomme** pas le RNG de la partie : elle est appelée à
 * chaque tick, donc elle en décalerait la séquence et deux parties de même
 * graine cesseraient d'être identiques. Elle en emprunte seulement la graine.
 *
 * C'est ce mélange qui manquait. L'ancien hash ne dépendait que du tick — il
 * était pourtant bien distribué, mais la taille d'une vague était la même dans
 * toutes les parties dont la livraison tombait au même tick, et la première
 * livraison tombe précisément toujours au même tick. Cinq graines différentes
 * sortaient cinq vagues de six monstres.
 */
function pick(tick: number, seed: number): number {
  let x = (tick * 0x9e3779b1 + seed) >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x21f0aaad) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x735a2d97) >>> 0
  x ^= x >>> 15
  // Le XOR de JavaScript rend un entier signé : sans ce dernier décalage non
  // signé, une valeur sur deux est négative et la taille de vague tombe sous
  // son minimum.
  return (x >>> 0) / 4294967296
}
