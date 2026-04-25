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
  app.get('/admin/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (event: AdminEvent): void => {
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = deps.emitter.subscribe(send);

    const keepalive = setInterval(() => {
      if (reply.raw.writableEnded) return;
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        // Socket closed between writableEnded check and write — let the 'close'
        // handler clean up the interval and subscription.
      }
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });
}
