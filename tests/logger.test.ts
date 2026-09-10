import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock obsidian DataAdapter
vi.mock('obsidian', () => ({}));

import { logger } from '../src/logger';

function createMockAdapter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
  } as any;
}

describe('logger', () => {
  let adapter: ReturnType<typeof createMockAdapter>;

  beforeEach(async () => {
    adapter = createMockAdapter();
    // Reset singleton state between tests to avoid cross-test pollution
    await logger.dispose();
    (logger as any)._channels.clear();
    (logger as any)._fileOutputFilter = null;
    (logger as any)._buffer = [];
    logger.setMinLevel('DEBUG');
    logger.setFileEnabled(true);
  });

  describe('init', () => {
    it('clears stale log file on startup', async () => {
      await logger.init(adapter, 'test-log.txt');
      expect(adapter.write).toHaveBeenCalledWith('test-log.txt', '');
      expect(adapter.write).toHaveBeenCalledTimes(1);
    });

    it('does not throw when adapter.write fails', async () => {
      adapter.write.mockRejectedValue(new Error('disk full'));
      await expect(
        logger.init(adapter, 'test-log.txt')
      ).resolves.not.toThrow();
    });
  });

  describe('dispose', () => {
    it('clears log file on dispose', async () => {
      await logger.init(adapter, 'test-log.txt');
      adapter.write.mockClear();

      logger.info('test message');
      await logger.dispose();

      const writeCalls = adapter.write.mock.calls;
      const clearCall = writeCalls.find(
        (c: string[]) => c[0] === 'test-log.txt' && c[1] === ''
      );
      expect(clearCall).toBeTruthy();
    });

    it('clears the flush interval timer on dispose', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      await logger.init(adapter, 'test-log.txt');
      await logger.dispose();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('sets adapter to null after dispose', async () => {
      await logger.init(adapter, 'test-log.txt');
      await logger.dispose();
    });
  });

  describe('flush', () => {
    it('writes buffered entries to file', async () => {
      await logger.dispose();
      await logger.init(adapter, 'test-log.txt');
      adapter.write.mockClear();

      (logger as any)._buffer.push({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'INFO',
        channel: 'default',
        message: 'test',
      });
      await logger.flush();

      const writeCalls = adapter.write.mock.calls.filter(
        (c: string[]) => c[0] === 'test-log.txt' && c[1] !== ''
      );
      expect(writeCalls.length).toBeGreaterThan(0);
    });

    it('does not crash when adapter is null', async () => {
      await logger.dispose();
      await expect(logger.flush()).resolves.not.toThrow();
    });
  });

  describe('log methods', () => {
    it('info adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.info('hello', { count: 1 });
      const buf = (logger as any)._buffer;
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[buf.length - 1].message).toBe('hello');
      expect(buf[buf.length - 1].data).toEqual({ count: 1 });
    });

    it('warn adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.warn('warning');
      const buf = (logger as any)._buffer;
      expect(buf[buf.length - 1].level).toBe('WARN');
    });

    it('error adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.error('oops');
      const buf = (logger as any)._buffer;
      expect(buf[buf.length - 1].level).toBe('ERROR');
    });

    it('debug adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.debug('trace');
      const buf = (logger as any)._buffer;
      expect(buf[buf.length - 1].level).toBe('DEBUG');
    });
  });

  describe('log lifecycle', () => {
    it('init → log → dispose clears file from both ends', async () => {
      await logger.init(adapter, 'test-log.txt');
      expect(adapter.write).toHaveBeenCalledWith('test-log.txt', '');

      logger.info('session start');
      logger.info('something happened');
      logger.warn('anomaly');
      logger.debug('details');
      expect((logger as any)._buffer.length).toBeGreaterThanOrEqual(4);

      adapter.write.mockClear();
      await logger.dispose();

      const calls = adapter.write.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toBe('');
    });
  });

  describe('channel', () => {
    it('returns same instance for same name', () => {
      const a = logger.channel('testMod');
      const b = logger.channel('testMod');
      expect(a).toBe(b);
    });

    it('creates channel with correct name', () => {
      const ch = logger.channel('testMod');
      expect(ch.name).toBe('testMod');
    });

    it('defaults outputToFile and outputToConsole to true', () => {
      const ch = logger.channel('testMod');
      expect(ch.outputToFile).toBe(true);
      expect(ch.outputToConsole).toBe(true);
    });

    it('accepts explicit overrides', () => {
      const ch = logger.channel('testMod');
      ch.outputToFile = false;
      expect(ch.outputToFile).toBe(false);
      ch.resetOutputToFile();
      expect(ch.outputToFile).toBe(true);
    });

    it('throws on depth > 3', () => {
      expect(() => logger.channel('a.b.c.d')).toThrow();
    });
  });

  describe('channel hierarchy', () => {
    it('child inherits parent outputToFile when not set', () => {
      const parent = logger.channel('parent');
      const child = logger.channel('parent.child');
      parent.outputToFile = false;
      expect(child.outputToFile).toBe(false);
    });

    it('child can override parent', () => {
      const parent = logger.channel('parent2');
      const child = logger.channel('parent2.child');
      parent.outputToFile = false;
      child.outputToFile = true;
      expect(child.outputToFile).toBe(true);
      expect(parent.outputToFile).toBe(false);
    });

    it('child resetOutputToFile restores inheritance', () => {
      const parent = logger.channel('parent3');
      const child = logger.channel('parent3.child');
      parent.outputToFile = false;
      child.outputToFile = true;
      child.resetOutputToFile();
      expect(child.outputToFile).toBe(false);
    });

    it('3-level chain inherits correctly', () => {
      const a = logger.channel('a');
      const b = logger.channel('a.b');
      const c = logger.channel('a.b.c');
      a.outputToFile = false;
      expect(b.outputToFile).toBe(false);
      expect(c.outputToFile).toBe(false);
      b.outputToFile = true;
      expect(b.outputToFile).toBe(true);
      expect(c.outputToFile).toBe(true);
    });
  });

  describe('file output filter', () => {
    it('filter excludes non-listed channels', () => {
      logger.setFileOutputFilter(['alpha']);
      const filter = (logger as any)._fileOutputFilter;
      expect(filter).toEqual(['alpha']);
    });

    it('matchFilter matches ancestor names', () => {
      logger.setFileOutputFilter(['livePreview']);
      const match = (logger as any)._matchFilter.bind(logger);
      expect(match('livePreview')).toBe(true);
      expect(match('livePreview.drag')).toBe(true);
      expect(match('livePreview.drag.resize')).toBe(true);
      expect(match('otherModule')).toBe(false);
    });

    it('clearFileOutputFilter restores full output', () => {
      logger.setFileOutputFilter(['alpha']);
      logger.clearFileOutputFilter();
      expect((logger as any)._fileOutputFilter).toBeNull();
    });
  });

  describe('listChannels', () => {
    it('returns all registered channels with status', () => {
      logger.channel('listTest1');
      logger.channel('listTest2');
      const channels = logger.listChannels();
      expect(channels.length).toBeGreaterThanOrEqual(2);
      const names = channels.map(c => c.name);
      expect(names).toContain('listTest1');
      expect(names).toContain('listTest2');
    });
  });

  describe('min level gate', () => {
    const levelsIn = () =>
      (logger as any)._buffer.map((e: { level: string }) => e.level);

    it('default DEBUG forwards every level to the buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setMinLevel('DEBUG');
      const ch = logger.channel('gateDefault');
      ch.debug('d');
      ch.info('i');
      ch.warn('w');
      ch.error('e');
      expect(levelsIn()).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
    });

    it('WARN threshold keeps only WARN and ERROR', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setMinLevel('WARN');
      const ch = logger.channel('gateWarn');
      ch.debug('d');
      ch.info('i');
      ch.warn('w');
      ch.error('e');
      expect(levelsIn()).toEqual(['WARN', 'ERROR']);
    });

    it('ERROR threshold keeps only ERROR buffered', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setMinLevel('ERROR');
      const ch = logger.channel('gateError');
      ch.debug('d');
      ch.info('i');
      ch.warn('w');
      ch.error('e');
      expect(levelsIn()).toEqual(['ERROR']);
    });

    it('ERROR threshold silences the console below ERROR', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setMinLevel('ERROR');
      const ch = logger.channel('gateConsole');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      ch.debug('d');
      ch.info('i');
      ch.warn('w');
      ch.error('e');
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('[ERROR]');
      spy.mockRestore();
    });

    it('setFileEnabled(false) buffers nothing and writes nothing', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setFileEnabled(false);
      adapter.write.mockClear();
      const ch = logger.channel('gateNoFile');
      ch.error('e');
      ch.info('i');
      expect((logger as any)._buffer.length).toBe(0);
      await logger.flush();
      const nonEmpty = adapter.write.mock.calls.filter(
        (c: unknown[]) => c[1] !== ''
      );
      expect(nonEmpty.length).toBe(0);
    });

    it('channel console switch still applies on top of the level gate', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.setMinLevel('DEBUG');
      const ch = logger.channel('gateChannel');
      ch.outputToConsole = false;
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      ch.error('e');
      expect(spy.mock.calls.length).toBe(0);
      // Still buffered for the file sink — the two gates are independent.
      expect((logger as any)._buffer.length).toBe(1);
      spy.mockRestore();
    });
  });
});
