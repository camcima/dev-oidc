import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

export type AdminEvent = { type: 'config-changed'; slug: string };

export interface EventsEmitter {
  subscribe: (listener: (event: AdminEvent) => void) => () => void;
  emit: (event: AdminEvent) => void;
}

export function createEventsEmitter(): EventsEmitter {
  const listeners = new Set<(event: AdminEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

export interface EventsDeps {
  emitter: EventsEmitter;
}

export function registerEventsRoute(app: FastifyInstance, deps: EventsDeps): void {
  // Track open SSE responses so server shutdown can close them. Without this,
  // app.close() blocks waiting for these long-lived keep-alive connections.
  //
  // This MUST run as a preClose hook, not onClose: Fastify runs preClose hooks
  // before server.close() waits on in-flight requests, whereas onClose runs
  // only after they finish. The open /admin/events stream *is* the in-flight
  // request blocking shutdown, so an onClose hook would never get the chance
  // to end it (and the default forceCloseConnections: 'idle' won't touch an
  // active connection).
  const active = new Set<ServerResponse>();
  app.addHook('preClose', () => {
    for (const res of [...active]) {
      if (!res.writableEnded) res.end();
    }
  });

  app.get('/admin/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Flush the handshake now so the client's EventSource opens immediately
    // rather than waiting for the first event or keepalive frame.
    reply.raw.flushHeaders();
    active.add(reply.raw);

    const send = (event: AdminEvent): void => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = deps.emitter.subscribe(send);

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(keepalive);
      unsubscribe();
      active.delete(reply.raw);
    };

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) {
        cleanup();
        return;
      }
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, 15_000);

    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('finish', cleanup);
    reply.raw.on('error', cleanup);
  });
}
