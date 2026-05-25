import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventsEmitter, registerEventsRoute } from '@/admin/events.js';

describe('events', () => {
  it('writes the SSE handshake headers (200 + text/event-stream)', async () => {
    // Direct check on the handler: invoke registerEventsRoute and capture
    // what it writes to reply.raw.writeHead. Avoids bringing up a real
    // socket (the SSE stream stays open and would hang fetch-based tests).
    const emitter = createEventsEmitter();
    let writtenStatus: number | null = null;
    let writtenHeaders: Record<string, string> | null = null;
    const fakeReply = {
      raw: {
        writeHead: (status: number, headers: Record<string, string>): void => {
          writtenStatus = status;
          writtenHeaders = headers;
        },
        write: (): boolean => true,
        on: (): void => undefined,
        writableEnded: false,
      },
    };
    const fakeRequest = { raw: { on: (): void => undefined } };
    const app = {
      get: (
        _path: string,
        handler: (
          req: { raw: { on: () => void } },
          reply: typeof fakeReply,
        ) => void | Promise<void>,
      ): void => {
        void Promise.resolve(handler(fakeRequest, fakeReply));
      },
      addHook: (): void => undefined,
    } as unknown as FastifyInstance;
    registerEventsRoute(app, { emitter });

    // Give the microtask queue a tick so the handler runs.
    await Promise.resolve();
    expect(writtenStatus).toBe(200);
    expect(writtenHeaders).not.toBeNull();
    expect(writtenHeaders!['content-type']).toMatch(/text\/event-stream/);
  });

  it('writes a config-changed frame with the slug payload to subscribed clients', async () => {
    // Functional check at the SSE handler level: capture what registerEventsRoute
    // writes through Fastify's `reply.raw` for one event by stubbing the raw
    // response. This proves both that the listener fires and that the wire
    // format matches the SSE spec — without binding to a TCP socket.
    const emitter = createEventsEmitter();
    const writes: string[] = [];
    const fakeReply = {
      raw: {
        writeHead: (): void => undefined,
        write: (chunk: string): boolean => {
          writes.push(chunk);
          return true;
        },
        on: (): void => undefined,
        writableEnded: false,
      },
    };
    const fakeRequest = { raw: { on: (): void => undefined } };
    // Mimic Fastify's call site: invoke the registered handler directly.
    const app = {
      get: (
        _path: string,
        handler: (
          req: { raw: { on: () => void } },
          reply: typeof fakeReply,
        ) => void | Promise<void>,
      ): void => {
        void Promise.resolve(handler(fakeRequest, fakeReply));
      },
      addHook: (): void => undefined,
    } as unknown as FastifyInstance;
    registerEventsRoute(app, { emitter });

    emitter.emit({ type: 'config-changed', slug: 'my-tenant' });

    const eventLine = writes.find((w) => w.startsWith('event:'));
    const dataLine = writes.find((w) => w.startsWith('data:'));
    expect(eventLine).toBe('event: config-changed\n');
    expect(dataLine).toContain('"slug":"my-tenant"');
    expect(dataLine).toContain('"type":"config-changed"');
  });

  it('emitter fans out events to all subscribers', () => {
    const emitter = createEventsEmitter();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = emitter.subscribe((e) => a.push(e));
    const unsubB = emitter.subscribe((e) => b.push(e));

    emitter.emit({ type: 'config-changed', slug: '(legacy)' });
    emitter.emit({ type: 'config-changed', slug: '(legacy)' });

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);

    unsubA();
    emitter.emit({ type: 'config-changed', slug: '(legacy)' });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);

    unsubB();
  });

  it('emitted event carries the slug payload', () => {
    const emitter = createEventsEmitter();
    const received: unknown[] = [];
    emitter.subscribe((e) => received.push(e));

    emitter.emit({ type: 'config-changed', slug: 'my-tenant' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'config-changed', slug: 'my-tenant' });
  });
});

describe('events keepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(): {
    closeHandlers: Array<() => void>;
    finishHandlers: Array<() => void>;
    errorHandlers: Array<() => void>;
    requestCloseHandlers: Array<() => void>;
    closeHooks: Array<() => unknown>;
    fakeReply: {
      raw: {
        writeHead: () => void;
        write: (s: string) => boolean;
        on: (event: string, fn: () => void) => void;
        end: () => void;
        writableEnded: boolean;
        endCalls: number;
      };
    };
    fakeRequest: { raw: { on: (event: string, fn: () => void) => void } };
    writes: string[];
  } {
    const closeHandlers: Array<() => void> = [];
    const finishHandlers: Array<() => void> = [];
    const errorHandlers: Array<() => void> = [];
    const requestCloseHandlers: Array<() => void> = [];
    const closeHooks: Array<() => unknown> = [];
    const writes: string[] = [];
    const raw = {
      writeHead: (): void => undefined,
      write: (s: string): boolean => {
        writes.push(s);
        return true;
      },
      on: (event: string, fn: () => void): void => {
        if (event === 'close') closeHandlers.push(fn);
        else if (event === 'finish') finishHandlers.push(fn);
        else if (event === 'error') errorHandlers.push(fn);
      },
      end: (): void => {
        raw.endCalls += 1;
        raw.writableEnded = true;
      },
      writableEnded: false,
      endCalls: 0,
    };
    return {
      closeHandlers,
      finishHandlers,
      errorHandlers,
      requestCloseHandlers,
      closeHooks,
      writes,
      fakeReply: { raw },
      fakeRequest: {
        raw: {
          on: (event: string, fn: () => void): void => {
            if (event === 'close') requestCloseHandlers.push(fn);
          },
        },
      },
    };
  }

  function mountHandler(h: ReturnType<typeof harness>): ReturnType<typeof createEventsEmitter> {
    const emitter = createEventsEmitter();
    const app = {
      get: (
        _path: string,
        handler: (req: typeof h.fakeRequest, reply: typeof h.fakeReply) => void,
      ): void => {
        handler(h.fakeRequest, h.fakeReply);
      },
      addHook: (event: string, fn: () => unknown): void => {
        if (event === 'onClose') h.closeHooks.push(fn);
      },
    } as unknown as FastifyInstance;
    registerEventsRoute(app, { emitter });
    return emitter;
  }

  it('writes a keepalive frame on the 15s interval', () => {
    const h = harness();
    mountHandler(h);
    h.writes.length = 0;
    vi.advanceTimersByTime(15_000);
    expect(h.writes).toContain(': keepalive\n\n');
  });

  it('cleans up the keepalive interval when the request closes', () => {
    const h = harness();
    const emitter = mountHandler(h);
    expect(h.requestCloseHandlers).toHaveLength(1);
    h.requestCloseHandlers[0]!(); // simulate client disconnect
    h.writes.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(h.writes).toEqual([]);
    // Subsequent emits must not call the unsubscribed listener.
    emitter.emit({ type: 'config-changed', slug: 'x' });
    expect(h.writes).toEqual([]);
  });

  it('cleans up when reply.raw emits finish', () => {
    const h = harness();
    mountHandler(h);
    expect(h.finishHandlers).toHaveLength(1);
    h.finishHandlers[0]!();
    h.writes.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(h.writes).toEqual([]);
  });

  it('cleans up when keepalive write throws (socket closed mid-write)', () => {
    const h = harness();
    h.fakeReply.raw.write = (): boolean => {
      throw new Error('EPIPE');
    };
    mountHandler(h);
    // Trigger the keepalive interval — write throws → cleanup runs.
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
    // Subsequent intervals are cleared, so no further writes are attempted.
    h.fakeReply.raw.write = (s: string): boolean => {
      h.writes.push(s);
      return true;
    };
    vi.advanceTimersByTime(60_000);
    expect(h.writes).toEqual([]);
  });

  it('cleanup is idempotent (close + finish both fire)', () => {
    const h = harness();
    mountHandler(h);
    h.requestCloseHandlers[0]!();
    expect(() => h.finishHandlers[0]!()).not.toThrow();
    expect(() => h.errorHandlers[0]!()).not.toThrow();
  });

  it('registers an onClose hook that ends active SSE responses', async () => {
    const h = harness();
    mountHandler(h);
    expect(h.closeHooks).toHaveLength(1);
    expect(h.fakeReply.raw.endCalls).toBe(0);

    await h.closeHooks[0]!(); // server shutdown

    expect(h.fakeReply.raw.endCalls).toBe(1);
    // The keepalive interval must also stop so nothing keeps the loop alive.
    h.writes.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(h.writes).toEqual([]);
  });

  it('does not end an SSE response that already closed before shutdown', async () => {
    const h = harness();
    mountHandler(h);
    h.requestCloseHandlers[0]!(); // client disconnected first
    await h.closeHooks[0]!();
    expect(h.fakeReply.raw.endCalls).toBe(0);
  });
});
