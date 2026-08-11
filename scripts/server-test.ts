/**
 * Tests du serveur — ce que les tests moteur ne voient pas.
 *
 * Le moteur est pur et se teste en l'appelant. Le serveur, lui, tient les
 * frontières : ce qui entre du réseau, ce qui part sur le disque, ce qui
 * arrive aux sockets, et la comptabilité des runs. Chacune de ces frontières
 * a eu son bug ; chacune a désormais son verrou ici.
 *
 * Même harnais que engine-test : pas de framework, un `check` par contrat.
 * Les écritures vont dans un répertoire jetable — jamais dans data/.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPlayer, createGame, descend } from '@dc/engine'

// Le répertoire de données se décide AVANT d'importer persist : le module lit
// DATA_DIR à l'import, et on ne veut pas qu'un test écrase une vraie partie.
const DATA = await mkdtemp(join(tmpdir(), 'dc-server-test-'))
process.env.DATA_DIR = DATA

const { loadRoom, loadRun, saveRoom } = await import('../apps/server/src/persist.js')
const { Room } = await import('../apps/server/src/room.js')
const { RunTelemetry } = await import('../apps/server/src/telemetry.js')
const { MAX_MSG_BYTES, parseClientMsg, sanitizeInput } = await import(
  '../apps/server/src/validate.js'
)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('\nTests serveur\n')

// --- validation des messages ------------------------------------------------
{
  check('un input sain passe et garde ses valeurs', (() => {
    const i = sanitizeInput({ mx: 0.5, my: -0.5, aim: 2, attack: true, sprint: false })
    return i !== null && i.mx === 0.5 && i.my === -0.5 && i.aim === 2 && i.attack && !i.sprint
  })())
  check('un input qui n\'est pas un objet est refusé',
    sanitizeInput(null) === null && sanitizeInput('x') === null && sanitizeInput(42) === null)
  check('NaN et Infinity ne rentrent pas dans la simulation',
    sanitizeInput({ mx: NaN, my: 0, aim: 0 }) === null &&
    sanitizeInput({ mx: 0, my: Infinity, aim: 0 }) === null &&
    sanitizeInput({ mx: 0, my: 0, aim: Number.NaN }) === null)
  check('les axes sont bornés à [-1, 1]', (() => {
    const i = sanitizeInput({ mx: 5, my: -3, aim: 0 })
    return i !== null && i.mx === 1 && i.my === -1
  })())
  check('les impulsions exigent un vrai booléen', (() => {
    const i = sanitizeInput({ mx: 0, my: 0, aim: 0, attack: 'true', roll: 1, take: true })
    return i !== null && i.attack === false && i.roll === undefined && i.take === true
  })())

  check('le JSON invalide est refusé', parseClientMsg('{pas du json') === null)
  check('un type de message inconnu est refusé', parseClientMsg('{"t":"hack"}') === null)
  check('un ping sans horodatage fini est refusé',
    parseClientMsg('{"t":"ping"}') === null &&
    parseClientMsg('{"t":"ping","ts":"x"}') === null &&
    parseClientMsg('{"t":"ping","ts":12}') !== null)
  check('un join sans code de room textuel est refusé',
    parseClientMsg('{"t":"join","room":42,"name":"x"}') === null &&
    parseClientMsg('{"t":"join","room":"ABCD","name":"x"}') !== null)
  check('un message obèse est refusé',
    parseClientMsg(`{"t":"ping","ts":1,"pad":"${'x'.repeat(MAX_MSG_BYTES)}"}`) === null)
}

// --- sauvegardes : aller-retour, versions, corruption ------------------------
{
  const roomsDir = join(DATA, 'rooms')
  const fileOf = (code: string) => join(roomsDir, `${code}.json`)

  const state = createGame(123)
  addPlayer(state, 'p_alice', 'Alice')
  await saveRoom('TSTA', state, 3)
  const loaded = await loadRoom('TSTA')
  check('une sauvegarde se relit', loaded !== null)
  check('le compteur de runs voyage avec l\'état', loaded?.resets === 3)
  check('l\'étage et la carte reviennent intacts',
    loaded?.state?.floor === state.floor &&
    loaded?.state?.tiles.length === state.width * state.height)
  check('au chargement, chaque personnage attend son joueur dans les limbes',
    loaded?.state?.actors.p_alice?.offline === true)

  check('une room jamais sauvegardée donne une partie neuve, en silence',
    (await loadRoom('JAMAIS')) === null)

  await writeFile(fileOf('TSTV'), JSON.stringify({ v: 1, state: {} }), 'utf8')
  check('une version d\'avant est ignorée sans quarantaine',
    (await loadRoom('TSTV')) === null &&
    (await readFile(fileOf('TSTV'), 'utf8')).length > 0)

  await writeFile(fileOf('TSTC'), '{"v":8,"state":{tronqué', 'utf8')
  const corrupt = await loadRoom('TSTC')
  const after = await readdir(roomsDir)
  check('un fichier illisible part en quarantaine au lieu d\'être écrasé',
    corrupt === null &&
    !after.includes('TSTC.json') &&
    after.some((f) => f.startsWith('TSTC.json.corrupt-')))

  await writeFile(fileOf('TSTS'),
    JSON.stringify({ v: 8, state: { width: 'douze', height: 17, tiles: '', floor: 1, tick: 0, actors: {} } }),
    'utf8')
  const bogus = await loadRoom('TSTS')
  check('une structure inattendue part en quarantaine aussi',
    bogus === null &&
    (await readdir(roomsDir)).some((f) => f.startsWith('TSTS.json.corrupt-')))
}

// --- télémétrie : un enregistrement par (run, étage, scène) ------------------
{
  const state = createGame(999)
  addPlayer(state, 'p_t', 'Mesuré')
  const tel = new RunTelemetry('TSTT', state)

  // La traversée réelle du palier : 1 → … → 4 → SAS(5) → arène(5) → 6.
  const seen: string[] = []
  for (let i = 0; i < 6; i++) {
    state.events = []
    descend(state)
    tel.observe(state, state.events)
    seen.push(`${state.floor}${state.scene ? ':' + state.scene : ''}`)
  }
  check('la traversée passe bien par le palier',
    seen.join(' ') === '2 3 4 5:sas 5:boss 6', seen.join(' '))

  const record = tel.toRecord(state.seed, '2026-08-10T00:00:00Z', state)
  const fives = record.floors.filter((f) => f.floor === 5)
  check('SAS et arène ont chacun leur enregistrement, jamais fusionnés',
    fives.length === 2 && fives[0]?.scene === 'sas' && fives[1]?.scene === 'boss')
  check('tous les enregistrements portent leur run', record.floors.every((f) => f.run === 0))

  // Wipe : la run suivante repart à l'étage 1 SANS se recoller sur l'étage 1
  // de la précédente.
  const fresh = createGame(1000)
  addPlayer(fresh, 'p_t', 'Mesuré')
  const tel2 = new RunTelemetry('TSTT', fresh, record, (record.runs ?? 0) + 1)
  const rec2 = tel2.toRecord(fresh.seed, '2026-08-10T00:01:00Z', fresh)
  const ones = rec2.floors.filter((f) => f.floor === 1)
  check('après un wipe, l\'étage 1 de la nouvelle run est un enregistrement neuf',
    ones.length === 2 && ones.some((f) => f.run === 1))

  // Reprise de sauvegarde : même run, même étage, même scène → on continue le
  // MÊME enregistrement au lieu d'en rouvrir un.
  const tel3 = new RunTelemetry('TSTT', state, record, record.runs ?? 0)
  const rec3 = tel3.toRecord(state.seed, '2026-08-10T00:02:00Z', state)
  check('reprendre là où on s\'était arrêté ne duplique rien',
    rec3.floors.length === record.floors.length)
}

// --- la room et ses sockets --------------------------------------------------
interface FakeWs {
  OPEN: number
  readyState: number
  bufferedAmount: number
  sent: string[]
  closedWith: number | null
  send(payload: string): void
  close(code?: number): void
}
function fakeWs(): FakeWs {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closedWith: null,
    send(payload: string) { this.sent.push(payload) },
    close(code?: number) { this.closedWith = code ?? 0; this.readyState = 3 },
  }
}
const asWs = (w: FakeWs) => w as unknown as import('ws').WebSocket

{
  const room = new Room('TSTB')
  const w1 = fakeWs()
  const joined = room.join(asWs(w1), 'Alice')
  check('rejoindre crée le personnage et l\'accueille',
    joined.ok && room.state.actors.p_alice !== undefined &&
    w1.sent.some((p) => JSON.parse(p).t === 'welcome'))
  check('un joueur connecté est dans le monde', room.state.actors.p_alice?.offline === undefined)

  // Une impulsion ne dure qu'une frame client. Son retour à faux peut donc
  // arriver avant le tick serveur qui devait la lire : la room doit la garder
  // en réserve, puis la consommer exactement une fois.
  room.state.items.length = 0
  const repos = { mx: 0, my: 0, aim: 0, attack: false, sprint: false }
  room.setInput(asWs(w1), { ...repos, take: true })
  room.setInput(asWs(w1), repos)
  room.tick()
  const takeAt = room.state.actors.p_alice?.takeAt
  check('une impulsion brève survit à son paquet de relâchement', takeAt === room.state.tick)
  room.tick()
  check('une impulsion mise en réserve n\'est consommée qu\'une fois',
    room.state.actors.p_alice?.takeAt === takeAt && takeAt !== room.state.tick)

  room.leave(asWs(w1))
  check('fermer l\'onglet sort le personnage du monde sans le supprimer',
    room.state.actors.p_alice?.offline === true)

  const w1b = fakeWs()
  room.join(asWs(w1b), 'Alice')
  check('revenir le ramène', room.state.actors.p_alice?.offline === undefined)

  // Backpressure : la socket qui ne suit plus saute les paquets périmables.
  const w2 = fakeWs()
  room.join(asWs(w2), 'Bob')
  w2.bufferedAmount = 100 * 1024
  const w2Before = w2.sent.length
  room.broadcast({ t: 'state' } as never)
  check('un tampon plein saute le paquet d\'état', w2.sent.length === w2Before)

  w2.bufferedAmount = 0
  room.broadcast({ t: 'state' } as never)
  const resumed = w2.sent.slice(w2Before).map((p) => JSON.parse(p).t as string)
  check('la reprise commence par un étage complet', resumed.join(' ') === 'floor state', resumed.join(' '))

  w2.bufferedAmount = 2 * 1024 * 1024
  room.broadcast({ t: 'state' } as never)
  check('une socket noyée est fermée', w2.closedWith === 4003)

  // Après un wipe, les compteurs suivent le NOUVEL état — la sauvegarde
  // périodique ne reste plus suspendue de longues minutes.
  const internals = room as unknown as {
    lastSaveTick: number
    resetAtMs: number | null
    restart(): void
  }
  internals.lastSaveTick = 99999
  internals.resetAtMs = 5
  const resetsBefore = (room as unknown as { resets: number }).resets
  internals.restart()
  check('le wipe remet les compteurs avec l\'état neuf',
    internals.lastSaveTick === 0 && internals.resetAtMs === null && room.state.tick === 0)
  check('et la run suivante change de graine',
    (room as unknown as { resets: number }).resets === resetsBefore + 1)

  await room.persist()
  check('la room persiste son état', (await loadRoom('TSTB')) !== null)
}

// --- le wipe survit à l'arrêt du process ------------------------------------
// Les 2,5 secondes d'écran de fin étaient un trou : un arrêt dedans (SIGTERM
// d'un redéploiement, ou toute l'équipe qui se déconnecte et fige la room)
// sauvegardait la partie morte, et la reprise la rejouait.
{
  const room = new Room('TSTW')
  room.join(asWs(fakeWs()), 'Alice')
  const seedAvant = room.state.seed
  const resetsAvant = (room as unknown as { resets: number }).resets
  // Un wipe programmé qui n'arrivera jamais : le process s'arrête avant.
  ;(room as unknown as { resetAtMs: number | null }).resetAtMs = Date.now() + 900_000
  await room.persist()

  const saved = await loadRoom('TSTW')
  check('une partie morte ne se relit pas comme une partie vivante',
    saved !== null && saved.state === null)
  check('mais son compteur de runs a avancé', saved?.resets === resetsAvant + 1)

  const repris = new Room('TSTW', saved?.state, await loadRun('TSTW'), saved?.resets ?? 0)
  check('la reprise repart d\'une descente neuve',
    repris.state.tick === 0 && repris.state.floor === 1)
  check('sur une graine jamais jouée', repris.state.seed !== seedAvant)
  check('et personne ne ressuscite dans le donjon qui l\'a tué',
    Object.keys(repris.state.actors).every((id) => !id.startsWith('p_')))
}

{
  // Le vestiaire est un état comme un autre : il se sauvegarde et se relit.
  // Sans ça, une équipe qui referme l'onglet avant d'avoir choisi son arme
  // verrait sa sauvegarde mise en quarantaine à la reconnexion.
  const room = new Room('TSTV')
  room.join(asWs(fakeWs()), 'Alice')
  check('une partie neuve s\'ouvre dans le vestiaire', room.state.scene === 'entree')
  await room.persist()
  const saved = await loadRoom('TSTV')
  check('le vestiaire se relit sans quarantaine', saved?.state?.scene === 'entree')
  const repris = new Room('TSTV', saved?.state, null, saved?.resets ?? 0)
  repris.join(asWs(fakeWs()), 'Alice')
  repris.tick()
  check('et il se joue', repris.state.scene === 'entree' && repris.state.tick > 0)
}

{
  // Garde-fou : sans wipe en attente, une reprise reste une reprise.
  const room = new Room('TSTN')
  room.join(asWs(fakeWs()), 'Alice')
  room.state.floor = 4
  await room.persist()
  const saved = await loadRoom('TSTN')
  check('une sauvegarde ordinaire se reprend toujours',
    saved?.state?.floor === 4 && saved.resets === 0)
}

// --- une sauvegarde relue supporte son premier tick --------------------------
// La validation ne sert à rien si elle laisse passer un état qui tombe au
// premier tick : la quarantaine n'agit qu'au chargement, pas après.
{
  const roomsDir = join(DATA, 'rooms')
  const fileOf = (code: string) => join(roomsDir, `${code}.json`)

  const base = new Room('TSTM')
  base.join(asWs(fakeWs()), 'Alice')
  // On quitte le vestiaire : c'est un vrai étage du donjon qu'on veut mutiler,
  // avec ses monstres — sinon les mutations qui visent le bestiaire ne
  // mordraient sur rien et le test se croirait vert.
  descend(base.state)
  base.tick()
  await base.persist()
  check('la sauvegarde mutilée part bien d\'un étage peuplé',
    Object.values(base.state.actors).some((a) => a.kind === 'monster'))
  const brut = JSON.parse(await readFile(fileOf('TSTM'), 'utf8')) as {
    v: number
    state: Record<string, unknown>
  }

  /** Écrit une copie mutilée de la sauvegarde saine et tente de la relire. */
  const mutile = async (
    code: string,
    abime: (s: Record<string, unknown>) => void,
  ): Promise<{ lu: Awaited<ReturnType<typeof loadRoom>>; enQuarantaine: boolean }> => {
    const copie = JSON.parse(JSON.stringify(brut)) as typeof brut
    abime(copie.state)
    await writeFile(fileOf(code), JSON.stringify(copie), 'utf8')
    const lu = await loadRoom(code)
    const enQuarantaine = (await readdir(roomsDir)).some((f) =>
      f.startsWith(`${code}.json.corrupt-`))
    return { lu, enQuarantaine }
  }

  const fatals: [string, (s: Record<string, unknown>) => void][] = [
    ['sans graine', (s) => delete s.seed],
    ['sans générateur', (s) => delete s.rng],
    ['sans compteur d\'identifiants', (s) => delete s.nextId],
    ['sans objets au sol', (s) => delete s.items],
    ['sans escalier', (s) => delete s.stairs],
    ['sans point d\'apparition', (s) => delete s.spawn],
    ['sans verrou d\'escalier', (s) => delete s.stairsLocked],
    ['aux acteurs en tableau', (s) => { s.actors = [] }],
    ['à l\'acteur sans position', (s) => {
      (s.actors as Record<string, Record<string, unknown>>).p_alice!.x = 'ici'
    }],
    ['à l\'espèce inconnue au bestiaire', (s) => {
      const a = s.actors as Record<string, Record<string, unknown>>
      const m = Object.values(a).find((x) => x.kind === 'monster')
      if (m) m.species = 'dragon_oublie'
    }],
    ['au piège dans une phase impossible', (s) => {
      s.trap = { room: { x: 1, y: 1, w: 5, h: 5 }, phase: 'oups', gates: [] }
    }],
  ]
  let fatalsOk = 0
  for (const [nom, abime] of fatals) {
    const code = `TX${fatalsOk}`
    const { lu, enQuarantaine } = await mutile(code, abime)
    if (lu === null && enQuarantaine) fatalsOk++
    else check(`une sauvegarde ${nom} part en quarantaine`, false, `${code}`)
  }
  check('toute sauvegarde qui tomberait au premier tick part en quarantaine',
    fatalsOk === fatals.length, `${fatalsOk}/${fatals.length}`)

  // Le garde-fou inverse, tout aussi important : ce qui est légitimement
  // absent doit continuer de se relire. Une validation trop zélée mettrait en
  // quarantaine la quasi-totalité des parties — tout étage ordinaire est sans
  // scène de palier et sans salle piégée.
  const tolerables: [string, (s: Record<string, unknown>) => void][] = [
    ['sans scène de palier', (s) => delete s.scene],
    ['sans décor', (s) => delete s.decor],
    ['sans salle piégée', (s) => delete s.trap],
    ['sans bourse d\'ossements', (s) => delete s.bones],
  ]
  let tolerablesOk = 0
  for (const [nom, abime] of tolerables) {
    const code = `TO${tolerablesOk}`
    const { lu } = await mutile(code, abime)
    if (lu?.state) {
      // Et la preuve par l'usage : l'état relu se joue vraiment.
      const r = new Room(code, lu.state)
      r.join(asWs(fakeWs()), 'Zoé')
      r.tick()
      tolerablesOk++
    } else {
      check(`une sauvegarde ${nom} se relit quand même`, false, code)
    }
  }
  check('ce qui est légitimement absent se relit et se joue',
    tolerablesOk === tolerables.length, `${tolerablesOk}/${tolerables.length}`)
}

// --- un relevé corrompu coûte la mesure, jamais la partie --------------------
{
  const runsDir = join(DATA, 'runs')
  const runFileOf = (code: string) => join(runsDir, `${code}.json`)

  await writeFile(runFileOf('TSTR'), '{"floors":{"length":3},"wipes":0}', 'utf8')
  const lu = await loadRun('TSTR')
  check('un relevé qui ment sur ses étages est refusé', lu === null)
  check('et part en quarantaine au lieu d\'être écrasé dix secondes plus tard',
    (await readdir(runsDir)).some((f) => f.startsWith('TSTR.json.corrupt-')))

  // Même passé en force, il ne doit pas faire tomber la construction : c'est
  // ce qui rendait la partie injoignable.
  let leve = false
  try {
    const t = new RunTelemetry('TSTR', createGame(1), { floors: { length: 3 } } as never)
    t.toRecord(1, '2026-08-10T00:00:00Z')
  } catch {
    leve = true
  }
  check('la télémétrie survit à un relevé mensonger', !leve)
}

// --- état et relevé décrivent toujours la même run ---------------------------
{
  const room = new Room('TSTP')
  room.join(asWs(fakeWs()), 'Alice')
  const ecriture = room.persist()
  // Une descente neuve s'intercale pendant l'écriture : avant, les deux
  // fichiers finissaient sur deux runs différentes.
  ;(room as unknown as { restart(): void }).restart()
  await ecriture
  await (room as unknown as { saving: Promise<void> }).saving

  const etat = await loadRoom('TSTP')
  const releve = await loadRun('TSTP')
  check('l\'état et le relevé sortent du même instant',
    etat?.state != null && releve != null &&
    releve.seed === etat.state.seed && (releve.runs ?? 0) === etat.resets,
    `run ${releve?.runs} vs resets ${etat?.resets}`)
}

{
  // Le compteur de runs ne redescend jamais : si un des deux fichiers est en
  // avance, c'est lui qui fait foi — sinon une graine serait rejouée.
  const state = createGame(4242)
  addPlayer(state, 'p_a', 'A')
  const enAvance = { room: 'TSTQ', seed: 1, updatedAt: '', floors: [], wipes: 0, runs: 5 }
  const room = new Room('TSTQ', state, enAvance, 2)
  check('un relevé en avance sur l\'état ne fait pas rejouer une graine',
    (room as unknown as { resets: number }).resets === 5)
}

await rm(DATA, { recursive: true, force: true })

console.log(failures === 0 ? '\nTout est vert.' : `\n${failures} échec(s).`)
process.exit(failures === 0 ? 0 : 1)
