#!/usr/bin/env python3
"""Copie les feuilles du pack Pixel Crawler vers public/assets/pack/.

Source : assets_src/ (les packs achetés, dézippés, hors dépôt). Ce script est
la seule vérité sur la correspondance espèce du jeu → fichier du pack ; le
client ne connaît que les noms normalisés qu'il produit.

Conventions produites :
- mobs : `<espece>_idle.png`, `<espece>_run.png`, `<espece>_death.png`,
  vue de côté uniquement (le rendu retourne le sprite selon la visée) ;
- héros : `hero_<anim>_<dir>.png` avec anim ∈ {idle, run, slice, pierce,
  crush} et dir ∈ {down, side, up} — le personnage est le Chasseur du pack
  Cemetery, seul personnage habillé disposant des trois attaques.

Les cadres s'animent de gauche à droite, mais **ils ne sont pas toujours
carrés** : les animations de mort où le corps s'effondre en travers (squelette,
orc guerrier) sont plus larges que hautes. Deviner le découpage sur la hauteur
émiettait ces animations en morceaux pris à cheval sur deux cadres. Le nombre
de cadres est donc mesuré ici, une fois, et écrit dans `manifest.json` que le
client lit — il ne devine plus rien.
"""
import json
import shutil
import statistics
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets_src'
DST = ROOT / 'apps' / 'client' / 'public' / 'assets' / 'pack'

FREE = SRC / 'Free_Pack' / 'Pixel Crawler - Free Pack'
MOBS = FREE / 'Entities' / 'Mobs'
HUNTER = SRC / 'Cemetery' / 'Pixel Crawler - Cemetery' / 'Entities' / 'Characters' / 'A_Hunter'
BAT = SRC / 'Small_Bat' / 'Small_Bat'

CASTLE = SRC / 'Castle_Environment' / 'Pixel Crawler - Castle Environment 0.3'
ROYAL = CASTLE / 'Enemies' / 'Royal Crew'

# Espèce du jeu → dossier du mob dans le pack. Deux conventions cohabitent :
# le Free Pack range chaque animation dans son sous-dossier (Idle/Idle-Sheet),
# les packs d'environnement posent les feuilles à plat (Idle-Sheet direct) —
# copy_crew() essaie les deux.
CREWS = {
    'skeleton': MOBS / 'Skeleton Crew' / 'Skeleton - Base',
    'skeleton_warrior': MOBS / 'Skeleton Crew' / 'Skeleton - Warrior',
    'skeleton_mage': MOBS / 'Skeleton Crew' / 'Skeleton - Mage',
    'skeleton_rogue': MOBS / 'Skeleton Crew' / 'Skeleton - Rogue',
    'orc': MOBS / 'Orc Crew' / 'Orc',
    'orc_warrior': MOBS / 'Orc Crew' / 'Orc - Warrior',
    'orc_mage': MOBS / 'Orc Crew' / 'Orc - Shaman',
    'orc_rogue': MOBS / 'Orc Crew' / 'Orc - Rogue',
    'soldat': ROYAL / 'Soldier',
    'archer_royal': ROYAL / 'Archer',
    'pretre': ROYAL / 'Priest',
    'chevalier': ROYAL / 'Knight',
    # Le boss d'arène : roche sombre aux veines de lave, jamais croisé dans un
    # pool d'étage — le pack Forge ne sert qu'à lui.
    'gardien': SRC / 'Forge' / 'Pixel Crawler - Forge' / 'Enemy' / 'Stone - Golem',
}

# Biome → feuille de tuiles. `tiles.png` reste le cachot historique ; les
# autres deviennent `tiles_<biome>.png`, mêmes cases de 16 px.
TILESETS = {
    'chateau': CASTLE / 'Assets' / 'Tiles.png',
    # Le SAS marchand : verdure et couleur, la respiration entre deux actes.
    'jardin': SRC / 'Garden_Environment' / 'Pixel Crawler - Garden Environment' / 'Assets' / 'Tiles.png',
}

# PNJ statiques, cuits dans la carte par le client (jamais animés) : premier
# cadre de leur feuille d'idle, produits en `npc_<nom>.png`.
NPCS = {
    'marchand': FREE / 'Entities' / "Npc's" / 'Citizen_F' / 'Tavern_A' / 'Idle' / 'Idle_Side-Sheet.png',
}

# Animation du héros → dossier chez le Chasseur. « Pierce_Top » est la seule
# entorse du pack à sa propre convention de nommage, corrigée ici.
HERO = {
    'idle': ('Idle_Base', 'Idle'),
    'run': ('Run_Base', 'Run'),
    'slice': ('Attack_01_Base', 'Slice'),
    'pierce': ('Attack_02_Base', 'Pierce'),
    'crush': ('Attack_03_Base', 'Crush'),
}
DIRS = {'down': 'Down', 'side': 'Side', 'up': 'Up'}

# Arme du jeu → case (colonne, ligne, largeur, hauteur) dans l'arsenal du pack
# Castle, en cases de 16 px. C'est l'acier du Chasseur : l'objet au sol et
# l'objet en main doivent être le même, sinon ramasser une arme désoriente.
WEAPON_ICONS = {
    'sword': (2, 2, 1, 2),
    'dagger': (3, 3, 1, 1),
    'axe': (7, 2, 1, 2),
    'spear': (4, 4, 1, 2),
    'bow': (11, 4, 2, 2),
}
ICON_CELL = 16


def copy(src: Path, name: str) -> None:
    if not src.exists():
        sys.exit(f'manquant : {src}')
    shutil.copyfile(src, DST / name)
    print(f'{name} <- {src.relative_to(SRC)}')


def bottom_gap(sheet: Image.Image) -> int:
    """Lignes transparentes sous le contenu, sur l'ensemble des cadres."""
    bbox = sheet.getbbox()
    return sheet.height - bbox[3] if bbox else 0


def shift_down(name: str, gap: int) -> None:
    """Descend toute la feuille de `gap` pixels (l'animation reste intacte)."""
    if gap <= 0:
        return
    path = DST / name
    sheet = Image.open(path).convert('RGBA')
    out = Image.new('RGBA', sheet.size, (0, 0, 0, 0))
    out.paste(sheet, (0, gap))
    out.save(path)
    print(f'{name} : abaissé de {gap}px')


def align_walkers() -> None:
    """Aligne les pieds sur le bord bas du cadre — l'invariant du rendu.

    Les mobs du pack le respectent déjà (décalage 0, no-op) ; les feuilles du
    Chasseur sont centrées dans leur canevas 64 px et doivent descendre. Pour
    lui, la ligne de sol est mesurée sur idle+course de chaque direction puis
    appliquée telle quelle aux feuilles d'attaque de la même direction : leurs
    cadres contiennent l'arc du coup, qui déborde et fausserait la mesure.
    La chauve-souris vole, ses cadres restent centrés.
    """
    for species in CREWS:
        for anim in ('idle', 'run', 'death'):
            name = f'{species}_{anim}.png'
            shift_down(name, bottom_gap(Image.open(DST / name).convert('RGBA')))

    for d in DIRS:
        gap = min(
            bottom_gap(Image.open(DST / f'hero_{anim}_{d}.png').convert('RGBA'))
            for anim in ('idle', 'run')
        )
        for anim in HERO:
            shift_down(f'hero_{anim}_{d}.png', gap)


def frame_count(sheet: Image.Image) -> int:
    """Combien de cadres dans cette feuille ?

    On repère les colonnes entièrement transparentes : elles séparent les
    cadres. Le pas entre deux blocs de contenu donne la largeur d'un cadre, à
    ceci près qu'un cadre où la pose déborde peut coller à son voisin — on
    ramène donc le pas mesuré au diviseur le plus proche de la largeur totale,
    puisqu'un découpage doit tomber juste. Sans bloc exploitable, on retombe
    sur la convention carrée du pack.
    """
    w, h = sheet.size
    px = sheet.load()
    filled = [any(px[x, y][3] > 10 for y in range(h)) for x in range(w)]

    centers: list[float] = []
    start = None
    for x, on in enumerate(filled):
        if on and start is None:
            start = x
        elif not on and start is not None:
            centers.append((start + x - 1) / 2)
            start = None
    if start is not None:
        centers.append((start + w - 1) / 2)

    if len(centers) < 2:
        return max(1, w // h)

    pitch = statistics.median(centers[i + 1] - centers[i] for i in range(len(centers) - 1))
    divisors = [d for d in range(8, w + 1) if w % d == 0]
    return w // min(divisors, key=lambda d: abs(d - pitch))


def write_manifest() -> None:
    counts = {
        path.stem: frame_count(Image.open(path).convert('RGBA'))
        for path in sorted(DST.glob('*.png'))
        if not path.stem.startswith(('tiles', 'weapon_', 'npc_'))
    }
    (DST / 'manifest.json').write_text(json.dumps(counts, indent=2, sort_keys=True) + '\n')
    odd = {n: c for n, c in counts.items() if c != Image.open(DST / f'{n}.png').width // Image.open(DST / f'{n}.png').height}
    print(f'manifest.json : {len(counts)} feuilles, {len(odd)} au découpage non carré {sorted(odd)}')


def cut_weapons() -> None:
    """Découpe l'arsenal en icônes, une par arme, rognées au contenu."""
    sheet = Image.open(CASTLE / 'Weapons' / 'Weapons.png').convert('RGBA')
    for weapon, (cx, cy, cw, ch) in WEAPON_ICONS.items():
        icon = sheet.crop((
            cx * ICON_CELL,
            cy * ICON_CELL,
            (cx + cw) * ICON_CELL,
            (cy + ch) * ICON_CELL,
        ))
        bbox = icon.getbbox()
        if bbox:
            icon = icon.crop(bbox)
        icon.save(DST / f'weapon_{weapon}.png')
        print(f'weapon_{weapon}.png : {icon.width}x{icon.height}')


def cut_npcs() -> None:
    """Premier cadre de l'idle de chaque PNJ : une image fixe à cuire dans la carte."""
    for name, sheet_path in NPCS.items():
        sheet = Image.open(sheet_path).convert('RGBA')
        frame = sheet.crop((0, 0, sheet.height, sheet.height))
        frame.save(DST / f'npc_{name}.png')
        print(f'npc_{name}.png : {frame.width}x{frame.height}')


def copy_crew(folder: Path, anim: str, name: str) -> None:
    """Copie une feuille de mob, quelle que soit la convention du pack."""
    nested = folder / anim / f'{anim}-Sheet.png'
    copy(nested if nested.exists() else folder / f'{anim}-Sheet.png', name)


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    for species, folder in CREWS.items():
        copy_crew(folder, 'Idle', f'{species}_idle.png')
        copy_crew(folder, 'Run', f'{species}_run.png')
        copy_crew(folder, 'Death', f'{species}_death.png')

    copy(BAT / 'Idle' / 'Idle_Side-Sheet.png', 'bat_idle.png')
    copy(BAT / 'Move' / 'Move_Side-Sheet.png', 'bat_run.png')
    copy(BAT / 'Death' / 'Death_Side-Sheet.png', 'bat_death.png')

    copy(FREE / 'Environment' / 'Tilesets' / 'Dungeon_Tiles.png', 'tiles.png')
    for biome, sheet in TILESETS.items():
        copy(sheet, f'tiles_{biome}.png')

    for anim, (folder, prefix) in HERO.items():
        for d, suffix in DIRS.items():
            base = HUNTER / folder / f'{prefix}_{suffix}-Sheet.png'
            if anim == 'pierce' and d == 'up':
                base = HUNTER / folder / f'{prefix}_Top-Sheet.png'
            copy(base, f'hero_{anim}_{d}.png')

    align_walkers()
    cut_weapons()
    cut_npcs()
    write_manifest()


if __name__ == '__main__':
    main()
