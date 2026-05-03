import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCertPair, findMkcert, type MkcertHandle } from '@/server/mkcert.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof NodeCrypto>();
  // Fake X509 reads { daysValid } from the buffer JSON to compute validTo.
  // Tests pass `Buffer.from(JSON.stringify({ daysValid: 100 }))` for "valid"
  // and `Buffer.from(JSON.stringify({ daysValid: 15 }))` for "expiring".
  // We use a class (not vi.fn) because the implementation invokes `new X509Certificate(...)`
  // and the production module is consumed via the default import (`import crypto from 'node:crypto'`).
  // The default export is overridden alongside the named export so both access paths see the fake.
  class FakeX509 {
    validTo: string;
    constructor(buf: Buffer) {
      const meta = JSON.parse(buf.toString('utf-8')) as { daysValid: number };
      this.validTo = new Date(Date.now() + meta.daysValid * 24 * 60 * 60 * 1000).toISOString();
    }
  }
  const merged = {
    ...actual,
    X509Certificate: FakeX509 as unknown as typeof actual.X509Certificate,
  };
  return {
    ...merged,
    default: merged,
  };
});

import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import type * as NodeCrypto from 'node:crypto';

// `promisify(execFile)` calls the underlying fn as `execFile(file, args, callback)` and
// expects the callback invoked with `(err, { stdout, stderr })`. Our mock matches that
// 3-arg shape. The callback resolves the promisified result with the second-arg object.
type ExecFileCb = (
  err: NodeJS.ErrnoException | null,
  result?: { stdout: string; stderr: string },
) => void;

describe('findMkcert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns { ok: false, kind: "not-found" } when mkcert binary is not in PATH', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: ExecFileCb) => {
      // simulate `which mkcert` failing
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      return {} as never;
    }) as unknown as typeof execFile);

    const result = await findMkcert();
    expect(result).toEqual({ ok: false, kind: 'not-found' });
  });

  it('returns { ok: true, handle } when mkcert is available and CAROOT/rootCA.pem exists', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
      // first call resolves `which mkcert` (or equivalent); second resolves -CAROOT
      if (cmd.endsWith('which') || cmd.endsWith('where.exe')) {
        cb(null, { stdout: '/usr/bin/mkcert\n', stderr: '' });
      } else if (Array.isArray(args) && args.includes('-CAROOT')) {
        cb(null, { stdout: '/home/test/.local/share/mkcert\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return {} as never;
    }) as unknown as typeof execFile);
    vi.mocked(access).mockResolvedValueOnce(undefined); // rootCA.pem exists

    const result = await findMkcert();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.binary).toBe('/usr/bin/mkcert');
      expect(result.handle.caroot).toBe('/home/test/.local/share/mkcert');
    }
  });

  it('returns { ok: false, kind: "caroot-uninitialized", caroot } when rootCA.pem is missing', async () => {
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
      if (cmd.endsWith('which') || cmd.endsWith('where.exe')) {
        cb(null, { stdout: '/usr/bin/mkcert\n', stderr: '' });
      } else if (Array.isArray(args) && args.includes('-CAROOT')) {
        cb(null, { stdout: '/home/test/.local/share/mkcert\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return {} as never;
    }) as unknown as typeof execFile);
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await findMkcert();
    expect(result).toEqual({
      ok: false,
      kind: 'caroot-uninitialized',
      caroot: '/home/test/.local/share/mkcert',
    });
  });

  it('honors $CAROOT env var when set, skipping `mkcert -CAROOT`', async () => {
    const oldCaroot = process.env.CAROOT;
    process.env.CAROOT = '/custom/caroot';
    try {
      vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
        if (cmd.endsWith('which') || cmd.endsWith('where.exe')) {
          cb(null, { stdout: '/usr/bin/mkcert\n', stderr: '' });
        } else {
          // -CAROOT should NOT be invoked when $CAROOT is set
          throw new Error('unexpected execFile call: ' + JSON.stringify(args));
        }
        return {} as never;
      }) as unknown as typeof execFile);
      vi.mocked(access).mockResolvedValueOnce(undefined);

      const result = await findMkcert();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.handle.caroot).toBe('/custom/caroot');
      }
    } finally {
      if (oldCaroot === undefined) delete process.env.CAROOT;
      else process.env.CAROOT = oldCaroot;
    }
  });
});

describe('ensureCertPair', () => {
  const mkcert: MkcertHandle = { binary: '/usr/bin/mkcert', caroot: '/c' };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws when hostnames is empty', async () => {
    await expect(ensureCertPair({ mkcert, cacheDir: '/cache', hostnames: [] })).rejects.toThrow(
      /hostnames must be non-empty/,
    );
  });

  it('returns deterministic cache paths derived from sorted hostnames', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    // Cert is "missing" in this test → readFile throws ENOENT → mkcert is invoked.
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: ExecFileCb) => {
      cb(null, { stdout: '', stderr: '' });
      return {} as never;
    }) as unknown as typeof execFile);

    const a = await ensureCertPair({
      mkcert,
      cacheDir: '/cache',
      hostnames: ['a.localhost', 'b.localhost'],
    });
    const b = await ensureCertPair({
      mkcert,
      cacheDir: '/cache',
      hostnames: ['b.localhost', 'a.localhost'], // sort-order reversed
    });

    expect(a.certPath).toBe(b.certPath); // sorting normalizes the cache key
    expect(a.keyPath).toBe(b.keyPath);
  });

  it('invokes mkcert when cache file is missing', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const calls: Array<unknown[]> = [];
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
      calls.push([cmd, args]);
      cb(null, { stdout: '', stderr: '' });
      return {} as never;
    }) as unknown as typeof execFile);

    await ensureCertPair({ mkcert, cacheDir: '/cache', hostnames: ['localhost'] });

    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('/usr/bin/mkcert');
    expect(calls[0]?.[1]).toEqual([
      '-cert-file',
      expect.stringMatching(/^\/cache\/[0-9a-f]{16}\.pem$/),
      '-key-file',
      expect.stringMatching(/^\/cache\/[0-9a-f]{16}-key\.pem$/),
      'localhost',
    ]);
  });

  it('skips mkcert when both cache files exist and cert is valid (>30d remaining)', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(Buffer.from(JSON.stringify({ daysValid: 100 })));
    vi.mocked(stat).mockResolvedValue({} as never);
    const calls: Array<unknown[]> = [];
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
      calls.push([cmd, args]);
      cb(null, { stdout: '', stderr: '' });
      return {} as never;
    }) as unknown as typeof execFile);

    await ensureCertPair({ mkcert, cacheDir: '/cache', hostnames: ['localhost'] });

    expect(calls.length).toBe(0); // mkcert not invoked
  });

  it('invokes mkcert when cert is within 30 days of expiry', async () => {
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(Buffer.from(JSON.stringify({ daysValid: 15 })));
    vi.mocked(stat).mockResolvedValue({} as never);
    const calls: Array<unknown[]> = [];
    vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], cb: ExecFileCb) => {
      calls.push([cmd, args]);
      cb(null, { stdout: '', stderr: '' });
      return {} as never;
    }) as unknown as typeof execFile);

    await ensureCertPair({ mkcert, cacheDir: '/cache', hostnames: ['localhost'] });

    expect(calls.length).toBe(1); // mkcert re-invoked due to imminent expiry
  });
});
