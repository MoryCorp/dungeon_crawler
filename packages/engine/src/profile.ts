/**
 * Profils de style — accumulation et lecture.
 *
 * L'accumulation vit dans `game.ts` (elle a besoin du tick) ; ici vivent la
 * création, l'accès paresseux et surtout `profileStats()`, seul endroit qui
 * transforme les sommes en moyennes. Télémétrie et rapport passent par lui :
 * un compte nul donne `null`, jamais un NaN qui ressemble à une mesure.
 */
import type { GameState, PlayerProfile } from './types.js'
import { TICK_RATE } from './types.js'

export function createProfile(): PlayerProfile {
  return {
    hitDistSum: 0,
    hitCount: 0,
    combatMoveSum: 0,
    combatTicks: 0,
    crowdSum: 0,
    hitsTakenCount: 0,
    allyDistSum: 0,
    allyTicks: 0,
    clearedSum: 0,
    floorsSeen: 0,
    fleeX: 0,
    fleeY: 0,
    moveX: 0,
    moveY: 0,
  }
}

/** Profil d'un joueur, créé au premier accès. */
export function profileOf(state: GameState, id: string): PlayerProfile {
  return (state.profiles[id] ??= createProfile())
}

/** Les moyennes dérivées d'un profil. `null` tant qu'il n'y a rien à moyenner. */
export interface ProfileStats {
  /** Distance moyenne à laquelle ce joueur inflige ses dégâts, en tuiles. */
  range: number | null
  /** Vitesse moyenne en combat, en tuiles par seconde. */
  mobility: number | null
  /** Ennemis engagés en moyenne au moment d'encaisser un coup. */
  crowding: number | null
  /** Distance moyenne au coéquipier le plus proche en combat. `null` en solo. */
  cohesion: number | null
  /** Part moyenne de l'étage tuée avant de descendre, entre 0 et 1. */
  patience: number | null
  /** Direction de fuite récente (EMA, norme < 1 tuile/tick). */
  flee: { x: number; y: number }
  /** Direction de déplacement récente, combat ou pas. */
  move: { x: number; y: number }
}

export function profileStats(p: PlayerProfile): ProfileStats {
  return {
    range: p.hitCount > 0 ? p.hitDistSum / p.hitCount : null,
    mobility: p.combatTicks > 0 ? (p.combatMoveSum / p.combatTicks) * TICK_RATE : null,
    crowding: p.hitsTakenCount > 0 ? p.crowdSum / p.hitsTakenCount : null,
    cohesion: p.allyTicks > 0 ? p.allyDistSum / p.allyTicks : null,
    patience: p.floorsSeen > 0 ? p.clearedSum / p.floorsSeen : null,
    flee: { x: p.fleeX, y: p.fleeY },
    move: { x: p.moveX, y: p.moveY },
  }
}
