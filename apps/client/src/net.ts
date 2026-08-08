import type { ClientMsg, ServerMsg } from '@dc/engine'

interface NetHandlers {
  onMessage: (msg: ServerMsg) => void
  onStatus: (status: 'connecting' | 'open' | 'closed') => void
}

/**
 * WebSocket avec reconnexion automatique.
 *
 * Le serveur conserve le personnage à la déconnexion et l'identité est dérivée
 * du pseudo : se reconnecter reprend le perso là où il était. Un refresh de
 * page ou un wifi qui saute ne coûte donc rien.
 */
export class Net {
  private ws: WebSocket | null = null
  private retry = 0
  private closedByUser = false
  private joinMsg: ClientMsg | null = null

  constructor(private readonly handlers: NetHandlers) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/ws`
  }

  connect(join: Extract<ClientMsg, { t: 'join' }>): void {
    this.joinMsg = join
    this.closedByUser = false
    this.open()
  }

  private open(): void {
    this.handlers.onStatus('connecting')
    const ws = new WebSocket(this.url())
    this.ws = ws

    ws.addEventListener('open', () => {
      this.retry = 0
      this.handlers.onStatus('open')
      if (this.joinMsg) ws.send(JSON.stringify(this.joinMsg))
    })

    ws.addEventListener('message', (ev) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data as string) as ServerMsg)
      } catch {
        /* message illisible : on ignore plutôt que de casser la boucle */
      }
    })

    ws.addEventListener('close', () => {
      this.handlers.onStatus('closed')
      if (this.closedByUser) return
      // Backoff plafonné à 5 s : on veut revenir vite sans marteler le serveur.
      const delay = Math.min(5000, 400 * 2 ** this.retry++)
      setTimeout(() => this.open(), delay)
    })

    ws.addEventListener('error', () => ws.close())
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close(): void {
    this.closedByUser = true
    this.ws?.close()
  }
}
