/**
 * Vérifie le modèle de puissance **analytiquement**, sans jouer une partie.
 *
 *   npx tsx scripts/curve.ts [étages]
 *
 * On n'équilibre pas des dégâts, on équilibre trois grandeurs :
 *
 *   TTK = PV du monstre / DPS du joueur      — temps pour tuer
 *   TTD = PV effectifs / DPS des monstres    — temps pour mourir
 *   K   = TTD / TTK                          — combien on en gère à la fois
 *
 * L'invariant : TTK et K constants sur toute la descente. S'ils dérivent, la
 * difficulté dérive avec eux et aucun réglage de détail ne le rattrapera. Ce
 * script le dit en une seconde, là où il faut vingt minutes pour le sentir.
 */
import {
  ATK_GROWTH,
  FLOOR_ATK_GROWTH,
  FLOOR_HP_GROWTH,
  HP_GROWTH,
  LEVELS_PER_FLOOR,
  MONSTERS,
  PLAYER_BASE_HP,
  TARGET_K,
  TARGET_TTK,
  TICK_RATE,
  WEAPONS,
  WEAPON_DPS,
  effectiveHp,
  floorScale,
  playerAttackMult,
  playerMaxHp,
  xpForLevel,
} from '@dc/engine'

const floors = Number(process.argv[2] ?? 20)

/** Monstre de référence : l'orc, le corps à corps le plus banal du jeu. */
const REF = MONSTERS.orc!
/** Menace de référence : trois orcs au contact. C'est la taille d'une meute. */
const PACK = 3

const secs = (t: number) => t / TICK_RATE

/** DPS nominal d'une arme au niveau donné, tous les coups touchant. */
function playerDps(weaponId: string, level: number): number {
  const w = WEAPONS[weaponId]!
  return (w.damage * playerAttackMult(level)) / secs(w.cooldown)
}

/** Cycle réel d'un monstre : préparation + récupération, pas la récupération seule. */
const refCycle = secs(REF.windup + REF.cooldown)

function levelAt(floor: number): number {
  return Math.max(1, Math.round(1 + LEVELS_PER_FLOOR * (floor - 1)))
}

console.log('\nModèle de puissance — vérification analytique\n')
console.log(`  Puissance joueur : ×${ATK_GROWTH} en attaque, ×${HP_GROWTH} en PV, par niveau`)
console.log(`  Rythme visé      : ${LEVELS_PER_FLOOR} niveau(x) par étage`)
console.log(
  `  Montée dérivée   : PV monstre ×${FLOOR_HP_GROWTH.toFixed(4)}, ` +
    `dégâts ×${FLOOR_ATK_GROWTH.toFixed(4)} par étage`,
)
console.log(`  Cibles           : TTK ${TARGET_TTK} s · K ${TARGET_K}\n`)

// --- l'invariant, étage par étage -------------------------------------------

console.log('── TTK, TTD et K le long de la descente ───────────────────────')
console.log('  (arme de référence : épée, menace de référence : 3 orcs)\n')
console.log('   étage  niveau      PV     TTK     TTD       K')

const ks: number[] = []
const ttks: number[] = []
for (let f = 1; f <= floors; f++) {
  const level = levelAt(f)
  const hp = playerMaxHp(level)
  const monsterHp = REF.maxHp * floorScale(f, FLOOR_HP_GROWTH)
  const monsterDps = (PACK * REF.atk * floorScale(f, FLOOR_ATK_GROWTH)) / refCycle

  const ttk = monsterHp / playerDps('sword', level)
  const ttd = effectiveHp(hp) / monsterDps
  const k = ttd / ttk
  ttks.push(ttk)
  ks.push(k)

  if (f <= 3 || f % 2 === 0 || f === floors) {
    console.log(
      `   ${String(f).padStart(5)}  ${String(level).padStart(6)}  ` +
        `${String(hp).padStart(6)}  ${ttk.toFixed(2).padStart(6)}  ` +
        `${ttd.toFixed(2).padStart(6)}  ${k.toFixed(2).padStart(6)}`,
    )
  }
}

const drift = (xs: number[]) => Math.max(...xs) / Math.min(...xs)
console.log(`\n  Dérive de TTK sur ${floors} étages : ×${drift(ttks).toFixed(3)}`)
console.log(`  Dérive de K   sur ${floors} étages : ×${drift(ks).toFixed(3)}`)
console.log(
  `  TTK moyen ${(ttks.reduce((a, b) => a + b, 0) / ttks.length).toFixed(2)} s ` +
    `(cible ${TARGET_TTK}) · K moyen ${(ks.reduce((a, b) => a + b, 0) / ks.length).toFixed(2)} ` +
    `(cible ${TARGET_K})`,
)

// --- budget des armes --------------------------------------------------------

console.log('\n── Budget des armes ───────────────────────────────────────────')
console.log('  Toutes doivent afficher le même DPS nominal. Un écart ici, et la')
console.log('  meilleure arme redevient un chiffre au lieu d\'un profil de risque.\n')

const dps = Object.entries(WEAPONS).map(([id, w]) => ({
  id,
  label: w.label,
  dps: playerDps(id, 1),
  perHit: w.damage,
  cd: secs(w.cooldown),
  engage: secs(w.swing) * (1 - w.movePenalty),
}))
for (const w of dps) {
  console.log(
    `  ${w.label.padEnd(7)} ${w.perHit.toFixed(2).padStart(6)} par coup · ` +
      `${w.cd.toFixed(2)} s de cadence · ${w.dps.toFixed(1).padStart(5)} DPS · ` +
      `engagement ${w.engage.toFixed(3)} s`,
  )
}
const spread = Math.max(...dps.map((w) => w.dps)) / Math.min(...dps.map((w) => w.dps))
console.log(`\n  Écart entre la meilleure et la pire : ×${spread.toFixed(3)} (cible ×1.000)`)
console.log(`  Budget visé : ${WEAPON_DPS} DPS`)

// --- la courbe d'XP tient-elle le rythme ? -----------------------------------

console.log('\n── Rythme de progression ──────────────────────────────────────')
console.log('  L\'XP d\'un étage doit faire monter d\'environ LEVELS_PER_FLOOR.')
console.log('  Sinon la montée dérivée des monstres ne correspond plus à rien.\n')

/** XP posée au sol par un étage, en supposant qu'on tue tout. */
function floorXp(floor: number): number {
  const count = Math.min(46, 11 + floor * 3)
  // Composition moyenne : on prend la moyenne des espèces disponibles.
  const pool = Object.values(MONSTERS)
  const avgXp = pool.reduce((a, m) => a + m.xp, 0) / pool.length
  return Math.round(count * avgXp * floorScale(floor, FLOOR_HP_GROWTH))
}

let xp = 0
let level = 1
console.log('   étage   XP posée   XP cumulée   niveau   niveaux pris')
for (let f = 1; f <= floors; f++) {
  const before = level
  xp += floorXp(f)
  while (xp >= xpForLevel(level + 1)) level++
  if (f <= 3 || f % 2 === 0 || f === floors) {
    console.log(
      `   ${String(f).padStart(5)}   ${String(floorXp(f)).padStart(8)}   ` +
        `${String(xp).padStart(10)}   ${String(level).padStart(6)}   ${String(level - before).padStart(12)}`,
    )
  }
}
const pace = (level - 1) / (floors - 1)
console.log(
  `\n  Rythme réel : ${pace.toFixed(2)} niveau(x) par étage ` +
    `(cible ${LEVELS_PER_FLOOR}) — niveau ${level} à l'étage ${floors}`,
)
console.log(
  '  Note : en tuant tout. En pratique on en laisse, donc le rythme réel est\n' +
    '  plus bas — c\'est voulu, la poursuite fait payer ce qu\'on a laissé.\n',
)
