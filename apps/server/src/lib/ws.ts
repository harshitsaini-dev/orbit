import type { Server } from 'node:http';
import type { ClientEvent, ServerEvent } from '@orbit/shared-types';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Channel-based pub/sub over a single WebSocket server. Upload progress and sync
 * status are the only publishers today; both address a channel string that the
 * REST layer hands the client when it starts the work.
 */
class Hub {
  private wss: WebSocketServer | null = null;
  private readonly channels = new Map<string, Set<WebSocket>>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let event: ClientEvent;
        try {
          // `ws` hands over a Buffer, an ArrayBuffer, or an array of Buffers
          // depending on how the frame arrived. Calling toString() on the last
          // two yields "[object ArrayBuffer]" and the parse fails for a reason
          // nothing would explain.
          const text = Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : Buffer.from(raw).toString('utf8');

          event = JSON.parse(text) as ClientEvent;
        } catch {
          return;
        }
        if (event.type === 'subscribe') this.subscribe(event.channel, socket);
        if (event.type === 'unsubscribe') this.unsubscribe(event.channel, socket);
        if (event.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      });

      socket.on('close', () => {
        for (const subscribers of this.channels.values()) subscribers.delete(socket);
      });
    });
  }

  private subscribe(channel: string, socket: WebSocket): void {
    const set = this.channels.get(channel) ?? new Set<WebSocket>();
    set.add(socket);
    this.channels.set(channel, set);
  }

  private unsubscribe(channel: string, socket: WebSocket): void {
    this.channels.get(channel)?.delete(socket);
  }

  publish(channel: string, event: ServerEvent): void {
    const subscribers = this.channels.get(channel);
    if (!subscribers?.size) return;
    const payload = JSON.stringify(event);
    for (const socket of subscribers) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  get connectionCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  /**
   * Closes every socket so the process can exit.
   *
   * A WebSocket is a connection that by design never ends, so `server.close()`
   * waits for them forever - a shutdown that looks hung until the platform
   * gives up and kills the process, which is how an upload gets cut off mid
   * chunk instead of being told the server is going away.
   */
  close(): void {
    for (const socket of this.wss?.clients ?? []) {
      // 1001 is "going away", which is what this is; the client reconnects
      // rather than treating it as an error.
      socket.close(1001, 'server shutting down');
    }

    this.channels.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export const hub = new Hub();
