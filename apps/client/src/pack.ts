/**
 * Pack de sprites Pixel Crawler (Anokolisa) — chargement et découpage.
 *
 * Les feuilles vivent dans `public/assets/pack/` et NE SONT PAS dans le git
 * tant que le dépôt est public : la licence autorise leur usage dans le jeu,
 * pas leur redistribution en fichiers bruts. D'où la règle de conception de ce
 * module : **tout est optionnel**. Si les feuilles manquent (build sans
 * assets, dépôt cloné à nu), `loadPack()` rend false et le jeu retombe sur
 * l'atlas procédural — il reste jouable partout, juste moins beau.
 *
 * Convention des feuilles : cadres carrés, côté = hauteur de l'image, animation
 * de gauche à droite. C'est vrai pour toutes les feuilles du pack (idle 32×32,
 * course 64×64), donc aucun fichier de métadonnées n'est nécessaire.
 */
import { Assets, Rectangle, Texture } from 'pixi.js'

/**
 * Un jeu d'animations. Les cadres idle (32×32) et course (64×64) n'ont pas la
 * même taille mais dessinent le personnage à la même échelle source : on ne
 * normalise donc RIEN — 1 pixel source = 1 pixel monde, ancre au centre, et le
 * personnage garde sa taille en passant de l'un à l'autre.
 */
export interface AnimSet {
  idle: Texture[]
  run: Texture[]
}

const BASE = '/assets/pack/'

/** Espèces couvertes par le pack. Le kamikaze garde son sprite maison : une
 * bombe ronde reste plus lisible que n'importe quel monstre à pattes. */
const SPECIES = [
  'hero',
  'skeleton',
  'skeleton_warrior',
  'skeleton_mage',
  'skeleton_rogue',
  'orc',
  'orc_warrior',
  'orc_mage',
  'orc_rogue',
  'bat',
]

const sets = new Map<string, AnimSet>()
let ready = false

function slice(sheet: Texture): Texture[] {
  const side = sheet.height
  const count = Math.max(1, Math.floor(sheet.width / side))
  const frames: Texture[] = []
  for (let i = 0; i < count; i++) {
    frames.push(
      new Texture({ source: sheet.source, frame: new Rectangle(i * side, 0, side, side) }),
    )
  }
  return frames
}

/** Charge toutes les feuilles. Rend false si le pack n'est pas là — sans bruit. */
export async function loadPack(): Promise<boolean> {
  try {
    for (const sp of SPECIES) {
      const [idleSheet, runSheet] = await Promise.all([
        Assets.load<Texture>(`${BASE}${sp}_idle.png`),
        Assets.load<Texture>(`${BASE}${sp}_run.png`),
      ])
      idleSheet.source.scaleMode = 'nearest'
      runSheet.source.scaleMode = 'nearest'
      sets.set(sp, { idle: slice(idleSheet), run: slice(runSheet) })
    }
    ready = true
    return true
  } catch {
    sets.clear()
    return false
  }
}

export function packAnim(species: string, isPlayer: boolean): AnimSet | null {
  if (!ready) return null
  return sets.get(isPlayer ? 'hero' : species) ?? null
}
