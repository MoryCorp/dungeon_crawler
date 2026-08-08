/** Observateur : affiche l'état d'une room pendant quelques secondes. Debug uniquement. */
import WebSocket from 'ws'
import type { ServerMsg } from '@dc/engine'

const room = process.argv[2] ?? 'TEST'
const seconds = Number(process.argv[3] ?? 4)
const ws = new WebSocket(process.env.SMOKE_URL ?? 'ws://localhost:3000/ws')

ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room, name: 'Observateur' })))
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString()) as ServerMsg
  if (msg.t !== 'state') return
  if (msg.tick % 15 !== 0) return
  const line = msg.actors
    .map((a) => `${a.kind === 'player' ? '@' : '#'}${a.name}(${a.x},${a.y})${a.alive ? '' : '†'}`)
    .join(' ')
  console.log(`t=${msg.tick} étage=${msg.floor} ${line}`)
})

setTimeout(() => {
  ws.close()
  process.exit(0)
}, seconds * 1000)
