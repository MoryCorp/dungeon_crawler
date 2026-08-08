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

Toutes les feuilles sont des cadres carrés (côté = hauteur), animés de
gauche à droite : le client les découpe sans métadonnées.
"""
import shutil
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

# Espèce du jeu → dossier du mob dans le pack.
CREWS = {
    'skeleton': MOBS / 'Skeleton Crew' / 'Skeleton - Base',
    'skeleton_warrior': MOBS / 'Skeleton Crew' / 'Skeleton - Warrior',
    'skeleton_mage': MOBS / 'Skeleton Crew' / 'Skeleton - Mage',
    'skeleton_rogue': MOBS / 'Skeleton Crew' / 'Skeleton - Rogue',
    'orc': MOBS / 'Orc Crew' / 'Orc',
    'orc_warrior': MOBS / 'Orc Crew' / 'Orc - Warrior',
    'orc_mage': MOBS / 'Orc Crew' / 'Orc - Shaman',
    'orc_rogue': MOBS / 'Orc Crew' / 'Orc - Rogue',
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


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    for species, folder in CREWS.items():
        copy(folder / 'Idle' / 'Idle-Sheet.png', f'{species}_idle.png')
        copy(folder / 'Run' / 'Run-Sheet.png', f'{species}_run.png')
        copy(folder / 'Death' / 'Death-Sheet.png', f'{species}_death.png')

    copy(BAT / 'Idle' / 'Idle_Side-Sheet.png', 'bat_idle.png')
    copy(BAT / 'Move' / 'Move_Side-Sheet.png', 'bat_run.png')
    copy(BAT / 'Death' / 'Death_Side-Sheet.png', 'bat_death.png')

    for anim, (folder, prefix) in HERO.items():
        for d, suffix in DIRS.items():
            base = HUNTER / folder / f'{prefix}_{suffix}-Sheet.png'
            if anim == 'pierce' and d == 'up':
                base = HUNTER / folder / f'{prefix}_Top-Sheet.png'
            copy(base, f'hero_{anim}_{d}.png')

    align_walkers()


if __name__ == '__main__':
    main()
