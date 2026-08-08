/**
 * Serveur unique : sert le client statique ET la WebSocket de jeu.
 * Un seul container, un seul port — c'est ce qui rend le déploiement Coolify
 * trivial (build pack Dockerfile, port 3000, rien d'autre à câbler).
 */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { TICK_MS, type ClientMsg } from '@dc/engine'
import { loadRoom } from './persist.js'
import { Room } from './room.js'

const PORT = Number(process.env.PORT ?? 3000)
const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIST = resolve(HERE, '../../client/dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}

// ---------------------------------------------------------------- rooms

const rooms = new Map<string, Room>()
/**
 * Chargements en cours. Sans ça, deux joueurs qui rejoignent la même partie au
 * même instant passent tous les deux le `rooms.get()` avant que l'un ou l'autre
 * n'ait fini de lire la sauvegarde : on créerait deux Room concurrentes, et
 * celui qui perd la course se retrouve dans un donjon fantôme jamais tické.
 */
const loading = new Map<string, Promise<Room>>()

function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase()
  return /^[A-Z0-9]{3,8}$/.test(code) ? code : null
}

function getRoom(code: string): Promise<Room> {
  const existing = rooms.get(code)
  if (existing) return Promise.resolve(existing)

  let pending = loading.get(code)
  if (!pending) {
    pending = (async () => {
      const saved = await loadRoom(code)
      const room = new Room(code, saved)
      rooms.set(code, room)
      console.log(
        `[room ${code}] ${saved ? 'reprise de la sauvegarde' : 'nouvelle partie'} (étage ${room.state.floor})`,
      )
      return room
    })().finally(() => loading.delete(code))
    loading.set(code, pending)
  }
  return pending
}

// ---------------------------------------------------------------- http

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
    return
  }

  // SPA : tout ce qui n'est pas un fichier existant retombe sur index.html.
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(CLIENT_DIST, safe)

  if (!filePath.startsWith(CLIENT_DIST + sep) && filePath !== join(CLIENT_DIST, 'index.html')) {
    res.writeHead(403).end('Forbidden')
    return
  }

  let body: Buffer
  try {
    body = await readFile(filePath)
  } catch {
    try {
      filePath = join(CLIENT_DIST, 'index.html')
      body = await readFile(filePath)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end("Client non buildé. Lance `npm run dev` (dev) ou `npm run build` (prod).")
      return
    }
  }

  const type = MIME[extname(filePath)] ?? 'application/octet-stream'
  const immutable = filePath.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(body)
})

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server, path: '/ws' })
const socketRoom = new WeakMap<WebSocket, Room>()

wss.on('connection', (ws) => {
  let joined = false

  ws.on('message', async (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg
    } catch {
      return
    }

    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }))
      return
    }

    if (msg.t === 'join') {
      if (joined) return
      const code = normalizeCode(msg.room)
      if (!code) {
        ws.send(JSON.stringify({ t: 'error', msg: 'Code de partie invalide (3 à 8 caractères alphanumériques).' }))
        return
      }
      const name = (msg.name ?? '').trim().slice(0, 20) || 'Aventurier'
      const room = await getRoom(code)
      const result = room.join(ws, name)
      if (!result.ok) {
        ws.send(JSON.stringify({ t: 'error', msg: result.reason }))
        ws.close(4001, 'room pleine')
        return
      }
      joined = true
      socketRoom.set(ws, room)
      console.log(`[room ${code}] ${name} a rejoint (${room.clients.size}/4)`)
      return
    }

    if (msg.t === 'intent') {
      socketRoom.get(ws)?.setIntent(ws, msg.intent)
    }
  })

  ws.on('close', () => {
    const room = socketRoom.get(ws)
    if (!room) return
    room.leave(ws)
    socketRoom.delete(ws)
    console.log(`[room ${room.code}] déconnexion (${room.clients.size}/4)`)
    if (room.isEmpty) void room.persist()
  })

  ws.on('error', () => ws.close())
})

// ---------------------------------------------------------------- boucle

// Une seule horloge pour toutes les rooms. Les rooms vides ne tournent pas :
// le donjon est figé tant que personne n'est connecté, ce qui est exactement le
// comportement voulu pour reprendre une partie plus tard.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.isEmpty) continue
    try {
      room.tick()
    } catch (err) {
      console.error(`[room ${room.code}] erreur de tick:`, err)
    }
  }
}, TICK_MS)

// Décharge de la mémoire les rooms inactives (l'état reste sur disque).
setInterval(
  () => {
    for (const [code, room] of rooms) {
      if (room.isEmpty) {
        rooms.delete(code)
        void room.persist()
        console.log(`[room ${code}] déchargée`)
      }
    }
  },
  5 * 60 * 1000,
)

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} reçu, sauvegarde des parties en cours...`)
  await Promise.all([...rooms.values()].map((r) => r.persist()))
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

server.listen(PORT, () => {
  console.log(`Serveur sur http://localhost:${PORT}  (ws://localhost:${PORT}/ws)`)
})
