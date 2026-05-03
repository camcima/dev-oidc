import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTlsMaterial,
  TlsConfigurationError,
  type TlsConfigInput,
} from '@/server/tls-loader.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@/server/mkcert.js', () => ({
  findMkcert: vi.fn(),
  ensureCertPair: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { findMkcert, ensureCertPair } from '@/server/mkcert.js';

describe('loadTlsMaterial', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('BYO mode', () => {
    it('reads cert and key buffers from explicit absolute paths', async () => {
      const config: TlsConfigInput = { cert: '/p/cert.pem', key: '/p/key.pem' };
      vi.mocked(readFile).mockImplementation(async (p) => {
        if (String(p) === '/p/cert.pem') return Buffer.from('CERT');
        if (String(p) === '/p/key.pem') return Buffer.from('KEY');
        throw new Error('unexpected');
      });

      const result = await loadTlsMaterial({
        config,
        cacheDir: '/cache',
        defaultHostnames: ['localhost'],
      });

      expect(result.cert.toString()).toBe('CERT');
      expect(result.key.toString()).toBe('KEY');
    });

    it('throws TlsConfigurationError with code BYO_FILE_MISSING when cert is unreadable', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      try {
        await loadTlsMaterial({
          config: { cert: '/missing.pem', key: '/p/key.pem' },
          cacheDir: '/cache',
          defaultHostnames: ['localhost'],
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TlsConfigurationError);
        expect((err as TlsConfigurationError).code).toBe('BYO_FILE_MISSING');
        expect((err as Error).message).toMatch(/\/missing\.pem/);
      }
    });

    it('throws BYO_FILE_MISSING when key is unreadable', async () => {
      vi.mocked(readFile).mockImplementation(async (p) => {
        if (String(p) === '/p/cert.pem') return Buffer.from('CERT');
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await expect(
        loadTlsMaterial({
          config: { cert: '/p/cert.pem', key: '/p/key.pem' },
          cacheDir: '/cache',
          defaultHostnames: ['localhost'],
        }),
      ).rejects.toThrow(TlsConfigurationError);
    });

    it('throws PATH_NOT_ABSOLUTE when BYO paths are relative', async () => {
      try {
        await loadTlsMaterial({
          config: { cert: 'cert.pem', key: 'key.pem' },
          cacheDir: '/cache',
          defaultHostnames: ['localhost'],
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TlsConfigurationError);
        expect((err as TlsConfigurationError).code).toBe('PATH_NOT_ABSOLUTE');
      }
    });
  });

  describe('auto-mkcert mode', () => {
    it('returns cert/key buffers when mkcert is available', async () => {
      vi.mocked(findMkcert).mockResolvedValueOnce({ binary: '/usr/bin/mkcert', caroot: '/c' });
      vi.mocked(ensureCertPair).mockResolvedValueOnce({
        certPath: '/cache/abc.pem',
        keyPath: '/cache/abc-key.pem',
      });
      vi.mocked(readFile).mockImplementation(async (p) => {
        if (String(p) === '/cache/abc.pem') return Buffer.from('AUTO_CERT');
        if (String(p) === '/cache/abc-key.pem') return Buffer.from('AUTO_KEY');
        throw new Error('unexpected: ' + String(p));
      });

      const result = await loadTlsMaterial({
        config: { hostnames: ['a.localhost', 'b.localhost'] },
        cacheDir: '/cache',
        defaultHostnames: ['localhost'],
      });

      expect(result.cert.toString()).toBe('AUTO_CERT');
      expect(result.key.toString()).toBe('AUTO_KEY');
      expect(vi.mocked(ensureCertPair).mock.calls[0]![0].hostnames).toEqual([
        'a.localhost',
        'b.localhost',
      ]);
    });

    it('uses defaultHostnames when config.hostnames is omitted', async () => {
      vi.mocked(findMkcert).mockResolvedValueOnce({ binary: '/usr/bin/mkcert', caroot: '/c' });
      vi.mocked(ensureCertPair).mockResolvedValueOnce({
        certPath: '/cache/x.pem',
        keyPath: '/cache/x-key.pem',
      });
      vi.mocked(readFile).mockResolvedValue(Buffer.from('B'));

      await loadTlsMaterial({
        config: {},
        cacheDir: '/cache',
        defaultHostnames: ['127.0.0.1', 'localhost', 'dev-oidc.localhost'],
      });

      expect(vi.mocked(ensureCertPair).mock.calls[0]![0].hostnames).toEqual([
        '127.0.0.1',
        'localhost',
        'dev-oidc.localhost',
      ]);
    });

    it('throws MKCERT_NOT_FOUND when findMkcert returns null due to missing binary', async () => {
      vi.mocked(findMkcert).mockResolvedValueOnce(null);

      try {
        await loadTlsMaterial({
          config: {},
          cacheDir: '/cache',
          defaultHostnames: ['localhost'],
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TlsConfigurationError);
        expect((err as TlsConfigurationError).code).toBe('MKCERT_NOT_FOUND');
        expect((err as Error).message).toMatch(/Install from .*mkcert/);
      }
    });
  });
});
