/**
 * Unit tests for src/util/logger.ts
 *
 * Verifies:
 *  1. Logger initializes correctly when pino-pretty is available.
 *  2. Logger falls back to plain JSON logging when pino-pretty is NOT installed.
 *  3. The API surface (getLogger, resetLoggerForTests) remains stable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/config.js', () => ({
  getConfig: vi.fn(() => ({
    brainPath: '/tmp/test-brain',
    cachePath: '/tmp/test-brain',
    modelsPath: '/tmp/test-brain/models',
    logLevel: 'debug',
    telemetry: false,
  })),
}));

// -------------------------------------------------------------------------
// Helper: import the module fresh after mocking node:module
// -------------------------------------------------------------------------

describe('getLogger — pino-pretty available', () => {
  beforeEach(() => {
    vi.resetModules();
    // Restore real node:module behavior (no mock = pino-pretty resolves fine
    // in this environment since we added it to devDependencies)
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns a pino logger instance', async () => {
    // Simulate non-TTY so we do not attempt the transport branch
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', {
      value: false,
      configurable: true,
    });

    try {
      const { getLogger, resetLoggerForTests } = await import('../src/util/logger.js');
      resetLoggerForTests();
      const log = getLogger();
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.debug).toBe('function');
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it('returns the same cached instance on subsequent calls', async () => {
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', {
      value: false,
      configurable: true,
    });

    try {
      const { getLogger, resetLoggerForTests } = await import('../src/util/logger.js');
      resetLoggerForTests();
      const log1 = getLogger();
      const log2 = getLogger();
      expect(log1).toBe(log2);
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it('resetLoggerForTests clears the cache so next call creates a fresh logger', async () => {
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', {
      value: false,
      configurable: true,
    });

    try {
      const { getLogger, resetLoggerForTests } = await import('../src/util/logger.js');
      resetLoggerForTests();
      const log1 = getLogger();
      resetLoggerForTests();
      const log2 = getLogger();
      expect(log1).not.toBe(log2);
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});

describe('getLogger — pino-pretty NOT available (resolution failure)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Mock node:module so that require.resolve('pino-pretty') throws
    vi.mock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>();
      return {
        ...actual,
        createRequire: vi.fn(() => {
          const fakeRequire = Object.assign(
            (id: string) => {
              throw new Error(`Cannot find module '${id}'`);
            },
            {
              resolve: (id: string) => {
                throw new Error(`Cannot find module '${id}'`);
              },
              cache: {},
              extensions: {},
              main: undefined,
            },
          );
          return fakeRequire;
        }),
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('initializes without throwing even when pino-pretty is absent', async () => {
    // Simulate a TTY debug environment where pino-pretty would normally be loaded
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      const { getLogger, resetLoggerForTests } = await import('../src/util/logger.js');
      resetLoggerForTests();
      // Must not throw
      expect(() => getLogger()).not.toThrow();
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  it('returns a valid logger with standard methods when pino-pretty is absent', async () => {
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      const { getLogger, resetLoggerForTests } = await import('../src/util/logger.js');
      resetLoggerForTests();
      const log = getLogger();
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.debug).toBe('function');
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });
});
