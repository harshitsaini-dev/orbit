import type { ClientEvent, ServerEvent } from '@orbit/shared-types';

/**
 * Sending a file straight from one browser to another.
 *
 * The bytes go peer to peer over WebRTC and never reach Orbit at all - not the
 * server, not a provider, not a disk anywhere. Orbit's only part is
 * introducing the two ends to each other over the WebSocket it already has, and
 * the thing it passes along is opaque to it.
 *
 * **This costs nothing and is built so that it cannot start costing.** WebRTC
 * needs two supporting services. STUN, which tells a browser what its public
 * address looks like from outside, is free and account-free. TURN, which relays
 * the bytes when the two ends cannot reach each other directly, is neither -
 * it is bandwidth somebody has to pay for, and it is the one thing in this
 * feature that would turn into a bill.
 *
 * So there is no TURN, and there will not be. Roughly one connection in ten
 * fails without it - two peers behind symmetric NAT have no direct path - and
 * the answer to that is to notice, say so plainly, and point at the ordinary
 * way: upload it and share a link, which Orbit already does. A transfer that
 * silently never starts is the failure worth avoiding; one that says "this
 * pair of networks will not connect, here is the other way" is not a failure at
 * all.
 */

/**
 * Public STUN, and nothing else.
 *
 * Two of them from different operators, because a STUN server that is down is
 * a transfer that cannot start. They are asked for an address and nothing more:
 * no account, no key, no bytes of the file, and no cost.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * 16 KB a chunk.
 *
 * The practical ceiling for a data channel message that every browser will
 * carry; larger ones are fragmented or dropped depending on the implementation
 * at each end, and "works in Chrome, fails in Safari" is not a size worth
 * chasing.
 */
const CHUNK = 16 * 1024;

/**
 * Pause sending once this much is queued, resume at a quarter of it.
 *
 * Without backpressure a loop over a two-gigabyte file queues the whole thing
 * in memory in a few seconds and the tab is killed. The low-water mark is well
 * below the high one on purpose: resuming at the same threshold means pausing
 * again on the next chunk, which is a busy loop wearing a hat.
 */
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = HIGH_WATER / 4;

/** How long to wait for a connection before calling it hopeless. */
const CONNECT_TIMEOUT_MS = 25_000;

export interface Offered {
  name: string;
  size: number;
  type: string;
}

export type Phase =
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'done'
  | 'unreachable'
  | 'left'
  | 'failed';

export interface Progress {
  phase: Phase;
  bytes: number;
  total: number;
  /** Bytes per second over the last second, for something honest to show. */
  rate: number;
  file?: Offered;
  error?: string;
}

function socketUrl(): string {
  const base = import.meta.env.VITE_API_URL ?? '';

  if (base) return `${base.replace(/^http/, 'ws')}/ws`;
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

/**
 * The signalling half: a socket, a channel, and messages passed to the far end.
 *
 * Separate from the WebRTC half so that each can be reasoned about alone -
 * most of what goes wrong with a peer connection goes wrong here, in whether
 * the two ends are talking at all.
 */
class Signal {
  private socket: WebSocket | null = null;
  private readonly queue: unknown[] = [];

  constructor(
    private readonly handoff: string,
    private readonly onPayload: (payload: unknown) => void,
    private readonly onPeer: (present: boolean) => void,
    private readonly onFull: () => void,
  ) {}

  open(): void {
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.send({ type: 'subscribe', channel: `p2p:${this.handoff}` });
      for (const payload of this.queue.splice(0)) {
        this.send({ type: 'p2p:signal', handoff: this.handoff, payload });
      }
    });

    socket.addEventListener('message', (event) => {
      let message: ServerEvent;
      try {
        message = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return;
      }

      if (message.type === 'p2p:signal' && message.handoff === this.handoff) {
        this.onPayload(message.payload);
      }
      if (message.type === 'p2p:peer' && message.handoff === this.handoff) {
        this.onPeer(message.present);
      }
      if (message.type === 'p2p:full' && message.handoff === this.handoff) {
        this.onFull();
      }
    });
  }

  private send(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    }
  }

  /** Queued until the socket is open, so nothing said early is lost. */
  signal(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: 'p2p:signal', handoff: this.handoff, payload });
    } else {
      this.queue.push(payload);
    }
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

interface Wire {
  kind: 'meta' | 'end';
  file?: Offered;
}

/**
 * Exactly the bytes a view covers, as a buffer of its own.
 *
 * Not `view.buffer`. A `subarray` is a window onto a larger buffer, and its
 * `.buffer` is that whole larger thing - so sending it put the *entire* source
 * chunk on the wire instead of the few hundred bytes left over from it, and the
 * file arrived longer than it was sent. The byte-for-byte test is what caught
 * it; a test that only checked the transfer finished would have passed.
 */
function bytesOf(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** Everything both ends need, so the two sides differ only in what they do. */
function connection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

export interface Handle {
  cancel: () => void;
}

/**
 * The sending end. Offers, then streams the file once the channel opens.
 */
export function send(
  handoff: string,
  file: File,
  onProgress: (progress: Progress) => void,
): Handle {
  const peer = connection();
  const channel = peer.createDataChannel('file', { ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER;

  let cancelled = false;
  let started = 0;
  let lastBytes = 0;
  let lastAt = Date.now();
  let rate = 0;

  const report = (phase: Phase, bytes: number, error?: string): void => {
    onProgress({
      phase,
      bytes,
      total: file.size,
      rate,
      file: { name: file.name, size: file.size, type: file.type },
      ...(error ? { error } : {}),
    });
  };

  let offered = false;

  /*
   * The offer waits for somebody to offer it to.
   *
   * Sent the moment this end was ready, it went to an empty channel and was
   * dropped - the relay has nobody to pass it to and nothing stores it. The
   * receiver then joined into silence and both sides sat waiting, which looks
   * exactly like two networks that cannot reach each other.
   */
  const offer = async (): Promise<void> => {
    if (offered) return;
    offered = true;

    watch();

    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    signal.signal({ sdp: description });
    report('connecting', 0);
  };

  const signal: Signal = new Signal(
    handoff,
    (payload) => {
      void handle(payload);
    },
    (present) => {
      if (present) {
        void offer();
        return;
      }

      if (started > 0 && started < file.size) report('left', started);
    },
    () => report('failed', 0, 'Somebody else is already on this transfer'),
  );

  async function handle(payload: unknown): Promise<void> {
    const message = payload as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };

    if (message.sdp && message.sdp.type === 'answer') {
      await peer.setRemoteDescription(message.sdp);
    }
    if (message.ice) {
      try {
        await peer.addIceCandidate(message.ice);
      } catch {
        // A candidate that arrives before the description is set is normal and
        // not worth surfacing; the connection succeeds on the others.
      }
    }
  }

  peer.addEventListener('icecandidate', (event) => {
    if (event.candidate) signal.signal({ ice: event.candidate.toJSON() });
  });

  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'connected') report('connecting', 0);

    if (peer.connectionState === 'failed') {
      // The honest failure. Without TURN there is no path between some pairs
      // of networks, and pretending otherwise leaves somebody watching a bar
      // that will never move.
      report('unreachable', started);
    }
  });

  channel.addEventListener('open', () => {
    void stream();
  });

  /*
   * Started when the far end appears, not when this page loads. Counting from
   * load would call a transfer unreachable because nobody had opened the link
   * yet, which is not the same thing at all.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watch = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      if (channel.readyState !== 'open') report('unreachable', 0);
    }, CONNECT_TIMEOUT_MS);
  };

  async function stream(): Promise<void> {
    if (timer) clearTimeout(timer);

    channel.send(
      JSON.stringify({
        kind: 'meta',
        file: { name: file.name, size: file.size, type: file.type },
      } satisfies Wire),
    );

    report('transferring', 0);

    const reader = file.stream().getReader();
    let leftover = new Uint8Array(0);

    const pushable = async (): Promise<void> => {
      if (channel.bufferedAmount < HIGH_WATER) return;

      await new Promise<void>((resolve) => {
        const onLow = (): void => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
      });
    };

    try {
      for (;;) {
        if (cancelled) return;

        const { done, value } = await reader.read();
        if (done) break;

        let block =
          leftover.length === 0
            ? value
            : (() => {
                const joined = new Uint8Array(leftover.length + value.length);
                joined.set(leftover);
                joined.set(value, leftover.length);
                return joined;
              })();

        while (block.length >= CHUNK) {
          await pushable();
          if (cancelled) return;

          channel.send(bytesOf(block.subarray(0, CHUNK)));
          block = block.subarray(CHUNK);

          started += CHUNK;

          const now = Date.now();
          if (now - lastAt >= 500) {
            rate = ((started - lastBytes) * 1000) / (now - lastAt);
            lastBytes = started;
            lastAt = now;
          }

          report('transferring', started);
        }

        leftover = block;
      }

      if (leftover.length > 0) {
        await pushable();
        channel.send(bytesOf(leftover));
        started += leftover.length;
      }

      channel.send(JSON.stringify({ kind: 'end' } satisfies Wire));
      report('done', file.size);
    } catch (err) {
      report('failed', started, err instanceof Error ? err.message : 'The transfer stopped');
    }
  }

  signal.open();
  report('waiting', 0);

  return {
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      channel.close();
      peer.close();
      signal.close();
    },
  };
}

/**
 * The receiving end. Answers, collects, and hands back a Blob.
 */
export function receive(
  handoff: string,
  onProgress: (progress: Progress) => void,
  onFile: (file: File) => void,
): Handle {
  const peer = connection();

  const parts: BlobPart[] = [];
  let meta: Offered | null = null;
  let bytes = 0;
  let lastBytes = 0;
  let lastAt = Date.now();
  let rate = 0;
  let finished = false;

  const report = (phase: Phase, error?: string): void => {
    onProgress({
      phase,
      bytes,
      total: meta?.size ?? 0,
      rate,
      ...(meta ? { file: meta } : {}),
      ...(error ? { error } : {}),
    });
  };

  const signal = new Signal(
    handoff,
    (payload) => {
      void handle(payload);
    },
    (present) => {
      if (!present && !finished && bytes > 0) report('left');
    },
    () => report('failed', 'Somebody else is already on this transfer'),
  );

  async function handle(payload: unknown): Promise<void> {
    const message = payload as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };

    if (message.sdp && message.sdp.type === 'offer') {
      await peer.setRemoteDescription(message.sdp);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      signal.signal({ sdp: answer });
      watch();
      report('connecting');
    }

    if (message.ice) {
      try {
        await peer.addIceCandidate(message.ice);
      } catch {
        // Harmless before the description is set.
      }
    }
  }

  peer.addEventListener('icecandidate', (event) => {
    if (event.candidate) signal.signal({ ice: event.candidate.toJSON() });
  });

  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed') report('unreachable');
  });

  peer.addEventListener('datachannel', (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';

    channel.addEventListener('message', (message) => {
      if (typeof message.data === 'string') {
        const wire = JSON.parse(message.data) as Wire;

        if (wire.kind === 'meta' && wire.file) {
          meta = wire.file;
          report('transferring');
        }

        if (wire.kind === 'end') {
          finished = true;
          if (timer) clearTimeout(timer);
          const blob = new Blob(parts, { type: meta?.type || 'application/octet-stream' });
          onFile(new File([blob], meta?.name ?? 'file', { type: blob.type }));
          report('done');
          channel.close();
        }

        return;
      }

      parts.push(message.data as ArrayBuffer);
      bytes += (message.data as ArrayBuffer).byteLength;

      const now = Date.now();
      if (now - lastAt >= 500) {
        rate = ((bytes - lastBytes) * 1000) / (now - lastAt);
        lastBytes = bytes;
        lastAt = now;
      }

      report('transferring');
    });
  });

  /* Counted from the offer arriving, for the same reason as the other end. */
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watch = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      if (peer.connectionState !== 'connected') report('unreachable');
    }, CONNECT_TIMEOUT_MS);
  };

  signal.open();
  report('waiting');

  return {
    cancel: () => {
      if (timer) clearTimeout(timer);
      peer.close();
      signal.close();
    },
  };
}

/** A handoff id: the capability, so it is generated where nobody else sees it. */
export function newHandoff(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
