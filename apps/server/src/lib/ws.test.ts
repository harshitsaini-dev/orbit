import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

const { hub } = await import('./ws.js');

let server: Server;
let url: string;

before(async () => {
  server = createServer();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));

  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  url = `ws://127.0.0.1:${address.port}/ws`;
});

after(async () => {
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Peer {
  socket: WebSocket;
  seen: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function connect(): Promise<Peer> {
  const socket = new WebSocket(url);
  const seen: Array<Record<string, unknown>> = [];

  socket.on('message', (raw: Buffer) => {
    seen.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
  });

  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  return {
    socket,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      }),
  };
}

function send(peer: Peer, event: unknown): void {
  peer.socket.send(JSON.stringify(event));
}

/** Long enough for a frame to cross a loopback socket and be handled. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

describe('signalling relay', () => {
  it('passes a payload to the other end and not back to the sender', async () => {
    const a = await connect();
    const b = await connect();

    send(a, { type: 'subscribe', channel: 'p2p:one' });
    send(b, { type: 'subscribe', channel: 'p2p:one' });
    await settle();

    send(a, { type: 'p2p:signal', handoff: 'one', payload: { sdp: 'offer' } });
    await settle();

    const toB = b.seen.filter((m) => m.type === 'p2p:signal');
    const toA = a.seen.filter((m) => m.type === 'p2p:signal');

    assert.equal(toB.length, 1);
    assert.deepEqual(toB[0]!.payload, { sdp: 'offer' });
    // Echoed back, each end would have to filter its own offer out of its own
    // answer.
    assert.equal(toA.length, 0);

    await a.close();
    await b.close();
  });

  it('tells each end when the other is there', async () => {
    const a = await connect();
    send(a, { type: 'subscribe', channel: 'p2p:two' });
    await settle();

    // Alone: nobody to offer to. The sender waits rather than offering into an
    // empty room, which is a transfer that never starts.
    assert.deepEqual(
      a.seen.filter((m) => m.type === 'p2p:peer').map((m) => m.present),
      [false],
    );

    const b = await connect();
    send(b, { type: 'subscribe', channel: 'p2p:two' });
    await settle();

    assert.equal(
      a.seen.filter((m) => m.type === 'p2p:peer' && m.present === true).length,
      1,
    );

    await b.close();
    await settle();

    // And when they go, which is the difference between "still connecting" and
    // "they closed the tab".
    assert.equal(
      a.seen.filter((m) => m.type === 'p2p:peer' && m.present === false).length,
      2,
    );

    await a.close();
  });

  it('refuses a third arrival', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();

    send(a, { type: 'subscribe', channel: 'p2p:three' });
    send(b, { type: 'subscribe', channel: 'p2p:three' });
    await settle();
    send(c, { type: 'subscribe', channel: 'p2p:three' });
    await settle();

    assert.equal(c.seen.filter((m) => m.type === 'p2p:full').length, 1);

    // And having been refused, it hears nothing that passes between the two.
    send(a, { type: 'p2p:signal', handoff: 'three', payload: { sdp: 'offer' } });
    await settle();

    assert.equal(c.seen.filter((m) => m.type === 'p2p:signal').length, 0);

    await a.close();
    await b.close();
    await c.close();
  });

  it('will not relay for somebody who never joined', async () => {
    const a = await connect();
    const outsider = await connect();

    send(a, { type: 'subscribe', channel: 'p2p:four' });
    await settle();

    // Knowing the id is not enough to inject into the conversation without
    // being on the channel - otherwise a guessed id could plant an offer.
    send(outsider, { type: 'p2p:signal', handoff: 'four', payload: { sdp: 'forged' } });
    await settle();

    assert.equal(a.seen.filter((m) => m.type === 'p2p:signal').length, 0);

    await a.close();
    await outsider.close();
  });

  it('cannot be used to publish anywhere but a handoff', async () => {
    const a = await connect();
    const listener = await connect();

    // The upload channel a real client listens on.
    send(listener, { type: 'subscribe', channel: 'upload:abc' });
    send(a, { type: 'subscribe', channel: 'upload:abc' });
    await settle();

    // A relay without the prefix check would let this through, and a client
    // would act on a completion that never happened.
    send(a, { type: 'p2p:signal', handoff: '../upload:abc', payload: { type: 'upload:complete' } });
    await settle();

    assert.deepEqual(listener.seen, []);

    await a.close();
    await listener.close();
  });
});
