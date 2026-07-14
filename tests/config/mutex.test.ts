import { describe, expect, it } from 'vitest';
import { withConfigLock } from '@/config/mutex.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('withConfigLock', () => {
  it('serializes calls for the same path in submission order', async () => {
    const events: string[] = [];
    const first = withConfigLock('/tmp/a.json', async () => {
      events.push('first:start');
      await tick();
      events.push('first:end');
    });
    const second = withConfigLock('/tmp/a.json', async () => {
      events.push('second:start');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('does not serialize distinct paths', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = withConfigLock('/tmp/b.json', async () => {
      await gate;
      events.push('slow');
    });
    const fast = withConfigLock('/tmp/c.json', async () => {
      events.push('fast');
    });
    await fast;
    expect(events).toEqual(['fast']);
    release();
    await slow;
  });

  it('keeps working after a rejected mutation', async () => {
    await expect(
      withConfigLock('/tmp/d.json', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withConfigLock('/tmp/d.json', async () => 'ok')).resolves.toBe('ok');
  });
});
