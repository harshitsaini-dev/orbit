import type { Server } from 'node:http';
import type { ClientEvent, ServerEvent } from '@orbit/shared-types';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Channel-based pub/sub over a single WebSocket server. Upload progress and sync
 * status address a channel string that the REST layer hands the client when it
 * starts the work.
 *
 * It also carries the signalling for a direct browser-to-browser transfer,
 * which is the one case where a client publishes rather than only listening.
 * That is deliberately confined to channels beginning `p2p:` - without the
 * prefix check, anything with a socket could publish a fake `upload:complete`
 * to any upload it could name.
 */

/** The prefix a client is allowed to publish to, and only that. */
const RELAY_PREFIX = 'p2p:';

/**
 * A handoff has exactly two ends.
 *
 * Somebody who learns the id could otherwise sit on the channel and receive a
 * copy of every offer and candidate. Two is not a security boundary on its own
 * - the id is the capability, as with a share link - but a third arrival is
 * always either a mistake or an intrusion, and refusing it makes both visible
 * instead of silent.
 */
const HANDOFF_PEERS = 2;
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
        if (event.type === 'p2p:signal') this.relay(event.handoff, event.payload, socket);
        if (event.type === 'unsubscribe') this.unsubscribe(event.channel, socket);
        if (event.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      });

      socket.on('close', () => {
        for (const [channel, subscribers] of this.channels) {
          if (!subscribers.delete(socket)) continue;

          // A tab closed mid-transfer is the other end's business: it is the
          // difference between "still connecting" and "they have gone".
          if (channel.startsWith(RELAY_PREFIX)) this.announceDeparture(channel, subscribers);
        }
      });
    });
  }

  private subscribe(channel: string, socket: WebSocket): void {
    const set = this.channels.get(channel) ?? new Set<WebSocket>();

    if (channel.startsWith(RELAY_PREFIX) && !set.has(socket) && set.size >= HANDOFF_PEERS) {
      const handoff = channel.slice(RELAY_PREFIX.length);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'p2p:full', handoff }));
      }
      return;
    }

    set.add(socket);
    this.channels.set(channel, set);

    // Each end is told the other is there. Without it the side that arrived
    // first has no way to know when to start, and would either offer into an
    // empty room or sit waiting after the other had already joined.
    if (channel.startsWith(RELAY_PREFIX)) {
      const handoff = channel.slice(RELAY_PREFIX.length);
      const present = set.size >= HANDOFF_PEERS;

      for (const peer of set) {
        if (peer.readyState === peer.OPEN) {
          peer.send(JSON.stringify({ type: 'p2p:peer', handoff, present }));
        }
      }
    }
  }

  private unsubscribe(channel: string, socket: WebSocket): void {
    const set = this.channels.get(channel);
    if (!set?.delete(socket)) return;

    if (channel.startsWith(RELAY_PREFIX)) this.announceDeparture(channel, set);
  }

  /**
   * Passes one end's signalling to the other, and to nobody else.
   *
   * Never echoed back to the sender, which would otherwise have to filter its
   * own offer out of its own answer. The payload is not parsed: it is a session
   * description or an ICE candidate, and this is a post office.
   */
  private relay(handoff: string, payload: unknown, from: WebSocket): void {
    const channel = `${RELAY_PREFIX}${handoff}`;
    const subscribers = this.channels.get(channel);

    // Only somebody already on the channel may publish to it. Otherwise the id
    // would be enough to inject an offer without ever joining.
    if (!subscribers?.has(from)) return;

    const frame = JSON.stringify({ type: 'p2p:signal', handoff, payload });

    for (const peer of subscribers) {
      if (peer !== from && peer.readyState === peer.OPEN) peer.send(frame);
    }
  }

  private announceDeparture(channel: string, set: Set<WebSocket>): void {
    const handoff = channel.slice(RELAY_PREFIX.length);

    for (const peer of set) {
      if (peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'p2p:peer', handoff, present: false }));
      }
    }
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
