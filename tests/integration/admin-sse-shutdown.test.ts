import http from 'node:http';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createEventsEmitter, registerEventsRoute } from '@/admin/events.js';

// Regression for the SSE-shutdown finding: a unit test that calls the close
// hook directly cannot catch the lifecycle ordering bug, because onClose and
// preClose behave identically when invoked by hand. This brings up a real
// loopback server, opens a real /admin/events stream, and asserts app.close()
// actually completes — which only holds when the cleanup runs as a preClose
// hook (onClose runs too late, after the open stream it is meant to end).
describe('admin SSE shutdown (real server lifecycle)', () => {
  it('completes app.close() promptly while an SSE client is connected', async () => {
    const app = Fastify();
    registerEventsRoute(app, { emitter: createEventsEmitter() });
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const port = Number(new URL(addr).port);

    let client: http.IncomingMessage | undefined;
    try {
      client = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/admin/events' }, resolve);
        req.on('error', reject);
      });
      client.on('data', () => {}); // drain the stream
      client.on('error', () => {}); // ignore the reset when the server ends it
      expect(client.statusCode).toBe(200);

      const closedWithin = await Promise.race([
        app.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      expect(closedWithin).toBe(true);
    } finally {
      // If the assertion failed (close still pending), destroying the client
      // ends the stream so the dangling close resolves and the server frees up.
      client?.destroy();
      await app.close().catch(() => undefined);
    }
  });
});
