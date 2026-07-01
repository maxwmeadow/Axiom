import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'
import type { WsMessage } from '../src/shared/types'

export class WsHub extends EventEmitter {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()

  constructor(port = 7744) {
    super()
    this.wss = new WebSocketServer({ port })
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
      ws.on('error', () => this.clients.delete(ws))
    })
    console.log(`[archd] WebSocket hub listening on ws://localhost:${port}`)
  }

  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    }
    // Emit so archd/index.ts can forward to Electron IPC
    this.emit('message', message)
  }

  get connectionCount(): number {
    return this.clients.size
  }

  close(): void {
    this.wss.close()
  }
}
