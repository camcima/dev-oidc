import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findMkcert } from '@/server/mkcert.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';

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

  it('returns null when mkcert binary is not in PATH', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], cb: ExecFileCb) => {
      // simulate `which mkcert` failing
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }));
      return {} as never;
    }) as unknown as typeof execFile);

    const result = await findMkcert();
    expect(result).toBeNull();
  });

  it('returns a handle when mkcert is available and CAROOT/rootCA.pem exists', async () => {
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
    expect(result).not.toBeNull();
    expect(result?.binary).toBe('/usr/bin/mkcert');
    expect(result?.caroot).toBe('/home/test/.local/share/mkcert');
  });

  it('returns null when mkcert is in PATH but rootCA.pem is missing (CAROOT not initialized)', async () => {
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
    expect(result).toBeNull();
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
      expect(result?.caroot).toBe('/custom/caroot');
    } finally {
      if (oldCaroot === undefined) delete process.env.CAROOT;
      else process.env.CAROOT = oldCaroot;
    }
  });
});
