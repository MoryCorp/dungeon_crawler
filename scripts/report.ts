/**
 * Rapport d'équilibrage à partir des mesures d'une partie.
 *
 *   npx tsx scripts/report.ts ABCD                       # serveur local
 *   npx tsx scripts/report.ts ABCD https://donjon.exemple.fr
 *   npx tsx scripts/report.ts data/runs/ABCD.json        # fichier direct
 *
 * Ce que le rapport cherche à répondre, dans l'ordre :
 *   1. Où est le ventre mou ? (étages traversés sans jamais descendre en PV)
 *   2. Qui fait vraiment mal ? (dégâts subis par espèce)
 *   3. Qui ne sert à rien ? (espèces tuées sans avoir touché personne)
 *   4. Une arme domine-t-elle ? (dégâts et taux de touche par arme)
 *   5. La progression suit-elle la difficulté ? (niveau vs étage)
 */
import { readFile } from 'node:fs/promises'
import { MONSTERS, TARGET_K, TARGET_TTK, TICK_RATE, WEAPONS } from '@dc/engine'
import {
  engagement,
  floorInvariants,
  floorSummary,
  waves,
  type FloorRecord,
  type RunRecord,
} from '../apps/server/src/telemetry.js'

const target = process.argv[2]
const base = process.argv[3] ?? 'http://localhost:3000'

if (!target) {
  console.error('usage: npx tsx scripts/report.ts <CODE|fichier.json> [url du serveur]')
  process.exit(1)
}

async function loadRecord(): Promise<RunRecord> {
  if (target!.endsWith('.json')) {
    return JSON.parse(await readFile(target!, 'utf8')) as RunRecord
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/stats/${target!.toUpperCase()}`)
  if (!res.ok) {
    console.error(`Le serveur a répondu ${res.status} : ${await res.text()}`)
    process.exit(1)
  }
  return (await res.json()) as RunRecord
}

const label = (species: string): string => MONSTERS[species]?.label ?? species
const weaponLabel = (id: string): string => WEAPONS[id]?.label ?? id
const total = (t: Record<string, number>): number => Object.values(t).reduce((a, b) => a + b, 0)

function merge(target: Record<string, number>, source: Record<string, number>): void {
  for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v
}

/** Classement décroissant, avec la part de chacun dans le total. */
function ranked(tally: Record<string, number>, name: (k: string) => string): string[] {
  const sum = total(tally) || 1
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${name(k).padEnd(20)} ${String(v).padStart(6)}  ${((v / sum) * 100).toFixed(0).padStart(3)}%`)
}

const bar = (ratio: number, width = 24): string => {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width)
  return '█'.repeat(filled) + '·'.repeat(width - filled)
}

function report(run: RunRecord): void {
  console.log(`\nPartie ${run.room} · graine ${run.seed} · relevé du ${run.updatedAt}\n`)

  if (run.floors.length === 0) {
    console.log('Aucun étage enregistré.')
    return
  }

  console.log('── Déroulé étage par étage ────────────────────────────────────')
  for (const f of run.floors) console.log('  ' + floorSummary(f))

  console.log('\n── Tension ────────────────────────────────────────────────────')
  console.log('  PV au plus bas atteints, et part du temps passée sous 35 % de PV.')
  console.log('  Un étage où la barre de danger reste vide est un étage sans enjeu.\n')
  for (const f of run.floors) {
    console.log(
      `  étage ${String(f.floor).padStart(2)}  PV min ${bar(f.lowestHpRatio, 16)} ` +
        `${(f.lowestHpRatio * 100).toFixed(0).padStart(3)}%   ` +
        `danger ${bar(f.dangerRatio, 16)} ${(f.dangerRatio * 100).toFixed(0).padStart(3)}%`,
    )
  }

  // --- les invariants du modèle de puissance ---------------------------------
  console.log('\n── Invariants ─────────────────────────────────────────────────')
  console.log('  TTK : coups qui touchent × cadence, pour tuer un monstre.')
  console.log('        Comparable à la cible. Ne compte pas les coups dans le vide.')
  console.log('  K   : monstres tués avant d\'épuiser sa barre de vie. Inclut tout')
  console.log('        ce qu\'on fait pour éviter les coups, donc bien plus haut que')
  console.log('        le K analytique — c\'est sa PLATITUDE qui compte, pas sa valeur.\n')
  console.log(`   étage      TTK   écart cible        K`)

  const measured: { ttk: number[]; k: number[]; kFloors: number[] } = { ttk: [], k: [], kFloors: [] }
  for (const f of run.floors) {
    const { ttk, k } = floorInvariants(f)
    if (ttk !== null) measured.ttk.push(ttk)
    if (k !== null) {
      measured.k.push(k)
      measured.kFloors.push(f.floor)
    }
    console.log(
      `   ${String(f.floor).padStart(5)}  ` +
        (ttk === null
          ? '      —             —'
          : `${ttk.toFixed(2).padStart(7)}   ${(ttk / TARGET_TTK).toFixed(2).padStart(11)}×`) +
        `  ${k === null ? '       —' : k.toFixed(1).padStart(8)}`,
    )
  }

  const spread = (xs: number[]) => (xs.length < 2 ? 1 : Math.max(...xs) / Math.min(...xs))
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

  if (measured.ttk.length) {
    const m = mean(measured.ttk)
    console.log(
      `\n  TTK moyen ${m.toFixed(2)} s (cible ${TARGET_TTK}) · ` +
        `dérive ×${spread(measured.ttk).toFixed(2)}`,
    )
    if (m < TARGET_TTK * 0.7) {
      console.log('  → Les monstres meurent trop vite pour avoir le temps de menacer.')
    } else if (m > TARGET_TTK * 1.6) {
      console.log('  → Les monstres sont des éponges : le combat devient une corvée.')
    }
  }

  // La tendance compte plus que la valeur : un K qui grimpe avec la profondeur
  // veut dire que le donjon devient plus facile à mesure qu'on descend.
  if (measured.k.length >= 4) {
    const half = Math.floor(measured.k.length / 2)
    const early = mean(measured.k.slice(0, half))
    const late = mean(measured.k.slice(half))
    console.log(
      `  K moyen   ${mean(measured.k).toFixed(1)} · ` +
        `premiers étages ${early.toFixed(1)} → derniers ${late.toFixed(1)}`,
    )
    console.log(
      late > early * 1.3
        ? '  → Le donjon se ramollit en profondeur : on encaisse de moins en moins.'
        : late < early * 0.7
          ? '  → Le donjon durcit en profondeur. Voulu si c\'est progressif, pas si ça décroche.'
          : '  → K plat : la difficulté tient sur toute la descente.',
    )
  }

  // --- combien en même temps ? ----------------------------------------------
  console.log('\n── Rencontres réelles ─────────────────────────────────────────')
  console.log('  Le nombre d\'ennemis à portée, pas le nombre sur l\'étage. C\'est')
  console.log('  la seule grandeur dont dépend vraiment la difficulté : quarante')
  console.log('  monstres pris un par un, c\'est quarante fois rien.\n')
  console.log('   étage   médian    p90   pic   tête-à-tête   sans ennemi')

  const medians: number[] = []
  const soloShares: number[] = []
  for (const f of run.floors) {
    const e = engagement(f)
    if (!e) {
      console.log(`   ${String(f.floor).padStart(5)}        —      —     —             —             —`)
      continue
    }
    medians.push(e.median)
    soloShares.push(e.soloShare)
    console.log(
      `   ${String(f.floor).padStart(5)}   ${String(e.median).padStart(6)} ` +
        `${String(e.p90).padStart(6)} ${String(e.peak).padStart(5)}   ` +
        `${(e.soloShare * 100).toFixed(0).padStart(10)}%   ` +
        `${(e.idleShare * 100).toFixed(0).padStart(10)}%`,
    )
  }
  if (soloShares.length) {
    const solo = soloShares.reduce((a, b) => a + b, 0) / soloShares.length
    const med = medians.reduce((a, b) => a + b, 0) / medians.length
    console.log(`\n  Effectif médian sur la descente : ${med.toFixed(1)}`)
    console.log(`  Temps de combat passé en tête-à-tête : ${(solo * 100).toFixed(0)} %`)
    console.log(
      solo > 0.6
        ? '  → On combat presque toujours seul contre un. Il n\'y a aucune décision\n' +
            '    à prendre, quel que soit le nombre de monstres posés sur l\'étage.'
        : solo > 0.4
          ? '  → Beaucoup de tête-à-tête : les meutes se défont avant d\'arriver.'
          : '  → Les rencontres sont majoritairement groupées. C\'est ce qu\'on veut.',
    )
  }

  // --- le travail de la Directrice -------------------------------------------
  const anyWave = run.floors.some((f) => (f.hordes ?? []).length > 0 || (f.held ?? 0) > 0)
  if (anyWave) {
    console.log('\n── La Directrice ──────────────────────────────────────────────')
    console.log('  Elle ne pose pas les monstres, elle les livre : en groupe, hors de')
    console.log('  vue, quand l\'intensité est retombée. Les vagues non livrées sont')
    console.log('  des monstres que l\'étage contenait et que personne n\'a croisés.\n')
    console.log('   étage   vagues   taille moy.   plus grosse   livrés   non livrés')
    let totalWaves = 0
    let totalDelivered = 0
    let totalUnspent = 0
    for (const f of run.floors) {
      const w = waves(f)
      totalWaves += w.count
      totalDelivered += w.delivered
      totalUnspent += w.unspent
      console.log(
        `   ${String(f.floor).padStart(5)}   ${String(w.count).padStart(6)}   ` +
          `${w.mean.toFixed(1).padStart(11)}   ${String(w.biggest).padStart(11)}   ` +
          `${String(w.delivered).padStart(6)}   ${String(w.unspent).padStart(10)}`,
      )
    }
    const perFloor = run.floors.length ? totalWaves / run.floors.length : 0
    console.log(`\n  ${perFloor.toFixed(1)} vague(s) par étage, ${totalDelivered} monstres livrés`)
    const recipeTotals: Record<string, number> = {}
    for (const f of run.floors) merge(recipeTotals, f.recipes ?? {})
    const recipeLine = Object.entries(recipeTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r} ×${n}`)
      .join(' · ')
    if (recipeLine) console.log(`  Recettes : ${recipeLine}`)
    if (perFloor < 1) {
      console.log(
        '  → Presque aucune vague : soit la pression ne retombe jamais assez pour\n' +
          '    qu\'elle trouve un creux, soit elle n\'a nulle part où livrer.',
      )
    } else if (totalUnspent > totalDelivered) {
      console.log(
        '  → Plus de monstres gardés que livrés : les étages se traversent plus\n' +
          '    vite qu\'elle ne peut les dépenser.',
      )
    }
  }

  // --- ce que le bandit a appris ---------------------------------------------
  const learned = [...run.floors].reverse().find((f) => f.bandit && Object.keys(f.bandit).length)
  if (learned?.bandit) {
    console.log('\n── Ce que la Directrice a appris ──────────────────────────────')
    console.log('  Gain moyen de chaque recette : l\'intensité produite dans les')
    console.log('  secondes qui suivent la vague. Les recettes qui ne produisent')
    console.log('  rien sortiront moins — jamais zéro, l\'exploration continue.\n')
    for (const [playerId, arms] of Object.entries(learned.bandit)) {
      const name = learned.profiles?.[playerId]?.name ?? playerId
      const line = Object.entries(arms)
        .sort((a, b) => b[1].mean - a[1].mean)
        .map(([r, a]) => `${r} ${(a.mean * 100).toFixed(0)} % (×${a.n})`)
        .join(' · ')
      console.log(`  ${name.padEnd(12)} ${line}`)
    }
  }

  // --- les profils de style --------------------------------------------------
  // Le profil est cumulatif : celui du dernier étage qui en porte est le bon.
  const profiled = [...run.floors].reverse().find((f) => f.profiles && Object.keys(f.profiles).length)
  if (profiled?.profiles) {
    console.log('\n── Profils de style ───────────────────────────────────────────')
    console.log('  Comment chacun joue, mesuré — pas déclaré. C\'est la matière')
    console.log('  première de la future adaptation : avant de s\'en servir, il faut')
    console.log('  vérifier que ces chiffres décrivent vraiment le joueur.\n')
    const fmt = (v: number | null, digits = 1, suffix = '') =>
      v === null ? '—' : v.toFixed(digits) + suffix
    for (const p of Object.values(profiled.profiles)) {
      console.log(
        `  ${p.name.padEnd(12)} portée ${fmt(p.range)} t · ` +
          `mobilité ${fmt(p.mobility)} t/s · ` +
          `encombrement ${fmt(p.crowding)} · ` +
          `cohésion ${fmt(p.cohesion)}${p.cohesion === null ? '' : ' t'} · ` +
          `patience ${p.patience === null ? '—' : (p.patience * 100).toFixed(0) + ' %'}`,
      )
    }
  }

  // --- l'économie des cœurs --------------------------------------------------
  const hearts = run.floors.reduce(
    (a, f) => {
      a.dropped += f.heartsDropped ?? 0
      a.taken += f.heartsTaken ?? 0
      a.hpSum += f.heartHpSum ?? 0
      a.entry += f.nearEntryTicks ?? 0
      a.ticks += f.ticks
      return a
    },
    { dropped: 0, taken: 0, hpSum: 0, entry: 0, ticks: 0 },
  )
  if (hearts.dropped > 0) {
    console.log('\n── Économie des cœurs ─────────────────────────────────────────')
    console.log(
      `  ${hearts.taken} ramassé(s) sur ${hearts.dropped} tombé(s) — ` +
        `${(((hearts.dropped - hearts.taken) / hearts.dropped) * 100).toFixed(0)} % laissés au sol`,
    )
    if (hearts.taken > 0) {
      const avg = hearts.hpSum / hearts.taken
      console.log(`  PV moyens au moment de ramasser : ${(avg * 100).toFixed(0)} %`)
      if (avg < 0.5) {
        console.log(
          '  → Les cœurs sont gardés en réserve et rappelés au bon moment. La barre\n' +
            '    de vie n\'est plus une ressource qui s\'épuise mais un stock.',
        )
      }
    }
    const camp = hearts.ticks ? hearts.entry / hearts.ticks : 0
    console.log(
      `  Temps passé à moins de 5 tuiles de l'escalier d'arrivée : ${(camp * 100).toFixed(0)} %`,
    )
    if (camp > 0.3) {
      console.log(
        '  → L\'entrée est campée. Les poursuivants y débouchent un par un : au lieu\n' +
          '    d\'une pression, ils forment une file d\'attente de cibles isolées.',
      )
    }
  }

  const flat = run.floors.reduce(
    (acc, f) => {
      merge(acc.kills, f.kills)
      merge(acc.damageTaken, f.damageTaken)
      merge(acc.damageDealt, f.damageDealt)
      merge(acc.downedBy, f.downedBy)
      merge(acc.swings, f.swings)
      merge(acc.hits, f.hits)
      merge(acc.damageByWeapon, f.damageByWeapon)
      acc.downs += f.downs
      acc.deaths += f.deaths
      acc.revives += f.revives
      acc.ticks += f.ticks
      return acc
    },
    {
      kills: {} as Record<string, number>,
      damageTaken: {} as Record<string, number>,
      damageDealt: {} as Record<string, number>,
      downedBy: {} as Record<string, number>,
      swings: {} as Record<string, number>,
      hits: {} as Record<string, number>,
      damageByWeapon: {} as Record<string, number>,
      downs: 0,
      deaths: 0,
      revives: 0,
      ticks: 0,
    },
  )

  console.log('\n── Qui fait mal ───────────────────────────────────────────────')
  for (const line of ranked(flat.damageTaken, label)) console.log('  ' + line)

  if (Object.keys(flat.downedBy).length) {
    console.log('\n── Qui te met à terre ─────────────────────────────────────────')
    for (const line of ranked(flat.downedBy, label)) console.log('  ' + line)
  }

  console.log('\n── Menace par tué ─────────────────────────────────────────────')
  console.log('  Dégâts infligés à l\'équipe rapportés au nombre tués. Une espèce')
  console.log('  proche de zéro est du décor : elle meurt sans avoir existé.\n')
  const species = new Set([...Object.keys(flat.kills), ...Object.keys(flat.damageTaken)])
  const threat = [...species]
    .map((s) => ({
      s,
      kills: flat.kills[s] ?? 0,
      dmg: flat.damageTaken[s] ?? 0,
      per: (flat.damageTaken[s] ?? 0) / Math.max(1, flat.kills[s] ?? 0),
    }))
    .sort((a, b) => b.per - a.per)
  for (const t of threat) {
    console.log(
      `  ${label(t.s).padEnd(20)} ${String(t.kills).padStart(4)} tués  ` +
        `${String(t.dmg).padStart(6)} dégâts  ${t.per.toFixed(1).padStart(6)} par tué`,
    )
  }

  console.log('\n── Armes ──────────────────────────────────────────────────────')
  for (const id of Object.keys({ ...flat.swings, ...flat.hits })) {
    const swings = flat.swings[id] ?? 0
    const hits = flat.hits[id] ?? 0
    const dmg = flat.damageByWeapon[id] ?? 0
    console.log(
      `  ${weaponLabel(id).padEnd(10)} ${String(swings).padStart(5)} coups  ` +
        `${String(hits).padStart(5)} touchés (${swings ? ((hits / swings) * 100).toFixed(0) : '0'}%)  ` +
        `${String(dmg).padStart(6)} dégâts  ${(dmg / Math.max(1, swings)).toFixed(1)} par coup`,
    )
  }

  console.log('\n── Résumé ─────────────────────────────────────────────────────')
  const minutes = (flat.ticks / TICK_RATE / 60).toFixed(1)
  const last = run.floors[run.floors.length - 1]!
  console.log(`  ${run.floors.length} étage(s) en ${minutes} min · niveau final ${last.levelOut}`)
  console.log(`  ${total(flat.kills)} monstres tués · ${total(flat.damageDealt)} dégâts infligés`)
  console.log(`  ${flat.downs} mise(s) à terre · ${flat.revives} relève(s) · ${flat.deaths} mort(s)`)

  const bland = run.floors.filter((f: FloorRecord) => f.lowestHpRatio > 0.7 && f.dangerRatio < 0.02)
  if (bland.length) {
    console.log(
      `\n  Ventre mou : étage(s) ${bland.map((f) => f.floor).join(', ')} traversé(s) sans jamais` +
        ' descendre sous 70 % de PV.',
    )
  }
  console.log()
}

report(await loadRecord())
