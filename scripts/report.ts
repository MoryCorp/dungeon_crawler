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
import { MONSTERS, TICK_RATE, WEAPONS } from '@dc/engine'
import { floorSummary, type FloorRecord, type RunRecord } from '../apps/server/src/telemetry.js'

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
