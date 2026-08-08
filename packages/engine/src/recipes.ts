/**
 * Recettes de vagues — la Directrice décide QUAND, la recette décide QUOI et OÙ.
 *
 * Une vague sans recette est toujours la même : la meilleure espèce en stock,
 * quelque part hors de vue. Six recettes donnent aux vagues des intentions
 * différentes — ruer, clouer, prendre en tenaille, couper la route, harceler —
 * et le tirage est pour l'instant **uniforme** : la variété d'abord, et les
 * échantillons dont une future adaptation au style du joueur aura besoin.
 * Aucune recette ne touche aux statistiques : TTK et K sont hors de sa portée,
 * elle ne dispose que de la composition et de la géométrie.
 *
 * Tout est mono-espèce PAR GROUPE. C'est l'invariant des vagues : deux espèces
 * n'ont pas la même vitesse, un groupe mixte s'étire sur le trajet et arrive en
 * file indienne — le défaut exact que les vagues corrigent. Une recette à deux
 * groupes (clouage, tenaille) livre donc deux groupes homogènes, chacun le sien.
 */
import type { Rng } from './rng.js'
import type { RoomKind } from './mapgen.js'
import { MONSTERS, type Behavior } from './types.js'

export type RecipeName = 'ruee' | 'clouage' | 'tenaille' | 'mur' | 'tireurs' | 'harcelement'

export type Placement = 'standard' | 'near' | 'far' | 'flankA' | 'flankB' | 'front'

export interface RecipeGroup {
  /** Classe souhaitée. `resolveBehavior()` la ramène à ce qui existe à cet étage. */
  behavior: Behavior
  /** Part de l'effectif de la vague. Répartie au plus fort reste, groupe ≥ 1. */
  share: number
  placement: Placement
}

export interface Recipe {
  name: RecipeName
  groups: RecipeGroup[]
  /** Multiplicateur d'effectif : l'essaim n'existe qu'en nombre. */
  sizeMult: number
}

export const RECIPES: Recipe[] = [
  // La vague de base : de la mêlée, quelque part hors de vue.
  { name: 'ruee', sizeMult: 1, groups: [{ behavior: 'melee', share: 1, placement: 'standard' }] },
  // Clouer : des chargeurs engagent pendant que des archers tirent de loin.
  // La spécialité de la cible marche toujours — elle ne suffit plus seule.
  {
    name: 'clouage',
    sizeMult: 1,
    groups: [
      { behavior: 'charger', share: 0.5, placement: 'near' },
      { behavior: 'archer', share: 0.5, placement: 'far' },
    ],
  },
  // Prendre en tenaille : deux groupes de part et d'autre de la cible.
  {
    name: 'tenaille',
    sizeMult: 1,
    groups: [
      { behavior: 'melee', share: 0.5, placement: 'flankA' },
      { behavior: 'melee', share: 0.5, placement: 'flankB' },
    ],
  },
  // Couper la route : la vague se pose devant la direction de déplacement
  // récente de la cible — celui qui recule d'habitude trouve le recul occupé.
  { name: 'mur', sizeMult: 1, groups: [{ behavior: 'melee', share: 1, placement: 'front' }] },
  // Tenir à distance : des archers, loin. On ne peut pas les ignorer.
  { name: 'tireurs', sizeMult: 1, groups: [{ behavior: 'archer', share: 1, placement: 'far' }] },
  // Noyer sous le nombre : de l'essaim, plus nombreux mais fragile.
  { name: 'harcelement', sizeMult: 1.5, groups: [{ behavior: 'swarm', share: 1, placement: 'standard' }] },
]

/**
 * Les recettes jouables selon l'endroit où se trouve la cible. Le principe :
 * on n'interdit que ce que la géométrie rend mensonger — une tenaille sans
 * espace pour deux mâchoires, des tireurs sans ligne de vue. Le bandit
 * apprend sur le reste.
 *
 * - arène : tout est jouable, c'est sa définition ;
 * - galerie : longue et étroite — pas de tenaille, tout le reste brille ;
 * - piliers : les lignes de vue sont cassées — ni tireurs ni clouage ;
 * - couloir (hors de toute salle) : la ruée, le mur, le harcèlement — ce qui
 *   n'a besoin ni de flancs ni de distance ;
 * - standard et trésor : tout, comme avant le typage.
 */
export function recipesFor(kind: RoomKind | 'couloir'): Recipe[] {
  switch (kind) {
    case 'galerie':
      return RECIPES.filter((r) => r.name !== 'tenaille')
    case 'piliers':
      return RECIPES.filter((r) => r.name !== 'tireurs' && r.name !== 'clouage')
    case 'couloir':
      return RECIPES.filter((r) => r.name === 'ruee' || r.name === 'mur' || r.name === 'harcelement')
    default:
      return RECIPES
  }
}

/**
 * Chaînes de repli quand la classe demandée n'existe pas à cet étage — le
 * premier étage n'a que de la mêlée et de l'essaim, et une recette doit
 * toujours livrer quelque chose. On dégrade vers le comportement le plus
 * proche dans l'esprit, jamais vers rien.
 */
const FALLBACKS: Record<Behavior, Behavior[]> = {
  melee: ['melee', 'swarm'],
  archer: ['archer', 'charger', 'melee', 'swarm'],
  charger: ['charger', 'melee', 'swarm'],
  swarm: ['swarm', 'melee'],
  bomber: ['bomber', 'melee', 'swarm'],
}

export function resolveBehavior(wanted: Behavior, available: Set<Behavior>): Behavior {
  for (const b of FALLBACKS[wanted]) {
    if (available.has(b)) return b
  }
  // Introuvable même en repli : on prend n'importe quoi d'existant plutôt que
  // d'échouer — un étage sans aucune espèce n'existe pas.
  return available.values().next().value ?? wanted
}

/**
 * Répartit un effectif entre les groupes, au plus fort reste. Chaque groupe
 * reçoit au moins 1 tant qu'il y a de quoi ; en dessous, les premiers groupes
 * absorbent tout — une tenaille à un seul monstre est une ruée, et c'est bien.
 */
export function splitShares(count: number, shares: number[]): number[] {
  if (count <= 0 || shares.length === 0) return shares.map(() => 0)
  if (count < shares.length) {
    return shares.map((_, i) => (i < count ? 1 : 0))
  }
  const total = shares.reduce((a, b) => a + b, 0)
  const out = shares.map((sh) => Math.max(1, Math.floor((count * sh) / total)))
  let used = out.reduce((a, b) => a + b, 0)
  // Le reste va aux groupes dans l'ordre : déterministe et sans importance.
  for (let i = 0; used < count; i = (i + 1) % out.length) {
    out[i]! += 1
    used += 1
  }
  for (let i = 0; used > count; i = (i + 1) % out.length) {
    if (out[i]! > 1) {
      out[i]! -= 1
      used -= 1
    }
  }
  return out
}

/** Un groupe planifié : une espèce, sa provenance, son placement. */
export interface PlannedGroup {
  species: string
  fromDebt: number
  fromReserve: number
  placement: Placement
}

/**
 * Le cœur de la recette : décide, groupe par groupe, l'espèce et la provenance.
 *
 * La dette passe TOUJOURS en premier, même quand aucun poursuivant ne colle au
 * comportement demandé — sinon un joueur qui fuit devant des espèces que les
 * recettes ne demandent jamais aurait une dette impayable, c'est-à-dire pas de
 * dette du tout. Le complément vient de la réserve, sous la même bannière que
 * le groupe (mono-espèce), l'espèce étant tirée dans le pool de l'étage.
 */
export function planWave(
  recipe: Recipe,
  count: number,
  pool: string[],
  pursuers: Map<string, number>,
  rng: Rng,
): PlannedGroup[] {
  const available = new Set<Behavior>(pool.map((sp) => MONSTERS[sp]!.behavior))
  const debt = new Map(pursuers)
  let debtLeft = 0
  for (const n of debt.values()) debtLeft += n

  const sizes = splitShares(count, recipe.groups.map((g) => g.share))
  const out: PlannedGroup[] = []

  for (let i = 0; i < recipe.groups.length; i++) {
    const group = recipe.groups[i]!
    let size = sizes[i]!
    if (size <= 0) continue

    const behavior = resolveBehavior(group.behavior, available)

    // Choix d'espèce : un poursuivant du bon comportement d'abord, sinon le
    // poursuivant le mieux fourni (la dette doit sortir), sinon le pool.
    let species: string | null = null
    if (debtLeft > 0) {
      let bestN = 0
      for (const [sp, n] of debt) {
        if (n <= 0) continue
        const matches = MONSTERS[sp]!.behavior === behavior
        const score = n + (matches ? 1000 : 0)
        if (score > bestN) {
          bestN = score
          species = sp
        }
      }
    }
    if (species === null) {
      const candidates = pool.filter((sp) => MONSTERS[sp]!.behavior === behavior)
      species = candidates.length > 0 ? candidates[rng.int(candidates.length)]! : pool[rng.int(pool.length)]!
    }

    const owed = debt.get(species) ?? 0
    const fromDebt = Math.min(owed, size)
    if (fromDebt > 0) {
      debt.set(species, owed - fromDebt)
      debtLeft -= fromDebt
    }
    out.push({ species, fromDebt, fromReserve: size - fromDebt, placement: group.placement })
  }
  return out
}
