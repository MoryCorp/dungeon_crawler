/**
 * Le bandit — la Directrice apprend quelles recettes marchent sur qui.
 *
 * Un bandit manchot par joueur : chaque recette est un levier, chaque vague un
 * tirage, et le gain est l'intensité que la vague a réellement produite dans
 * les secondes qui suivent. Au fil des vagues, les recettes qui ne font rien à
 * ce joueur-là sortent moins, celles qui le mettent en difficulté sortent plus.
 * C'est l'échelle d'apprentissage adaptée à quatre amis : quelques dizaines de
 * vagues suffisent, là où un réseau de neurones en voudrait des centaines de
 * milliers.
 *
 * La mesure qui a rendu ça nécessaire (partie TEST5) : sur un joueur mobile au
 * corps à corps, les vagues de mêlée et d'essaim faisaient 0.1 dégât par
 * monstre — la moitié des munitions de la Directrice partait en vagues que le
 * joueur ne remarquait même pas — pendant que chargeurs et archers produisaient
 * l'essentiel du danger. Le tirage uniforme a servi à collecter ces
 * échantillons ; le bandit s'en sert.
 *
 * Garde-fous, non négociables :
 * - **Aucune recette n'est supprimée**, seulement re-pondérée : l'exploration
 *   (`BANDIT_EXPLORE`) garantit que tout continue de sortir de temps en temps,
 *   donc que la Directrice ne devient jamais prévisible — et qu'un joueur qui
 *   change de style est re-détecté.
 * - Le bandit choisit une recette, jamais des statistiques : TTK et K restent
 *   hors de sa portée.
 * - Déterministe : sélection par UCB (un calcul, pas un tirage) plus une part
 *   d'exploration au RNG de la partie, consommé uniquement au moment d'une
 *   livraison — jamais par tick.
 */
import type { Rng } from './rng.js'
import { RECIPES, type Recipe } from './recipes.js'
import {
  BANDIT_EXPLORE,
  BANDIT_UCB_C,
  type BanditArm,
  type BanditArms,
} from './types.js'

/**
 * Choisit la recette de la prochaine vague pour cette cible.
 *
 * UCB1 : on prend la recette qui maximise `gain moyen + bonus d'incertitude`.
 * Le bonus fond à mesure qu'une recette est essayée — une recette peu jouée
 * garde longtemps le bénéfice du doute, une recette éprouvée doit son rang à
 * ses résultats. Les recettes jamais tirées passent d'office en premier.
 */
export function pickRecipe(arms: BanditArms, rng: Rng): Recipe {
  // Part d'exploration pure : la surprise est une composante de la difficulté.
  if (rng.next() < BANDIT_EXPLORE) return RECIPES[rng.int(RECIPES.length)]!

  let total = 0
  for (const r of RECIPES) total += arms[r.name]?.n ?? 0

  let best: Recipe = RECIPES[0]!
  let bestScore = -Infinity
  for (const r of RECIPES) {
    const arm = arms[r.name]
    if (!arm || arm.n === 0) return r // jamais essayée : elle passe devant
    const mean = arm.sum / arm.n
    const score = mean + BANDIT_UCB_C * Math.sqrt(Math.log(Math.max(2, total)) / arm.n)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}

/** Inscrit le gain d'une vague au levier correspondant. */
export function recordReward(arms: BanditArms, recipe: string, reward: number): void {
  const arm: BanditArm = (arms[recipe] ??= { n: 0, sum: 0 })
  arm.n += 1
  arm.sum += Math.max(0, Math.min(1, reward))
}
