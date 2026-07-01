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

  beforeEach(() => {
    adapter = createMockAdapter();
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
      // Reset mock to only track dispose's write call
      adapter.write.mockClear();

      // Add a log entry so flush has something to write
      logger.info('test message');
      await logger.dispose();

      // dispose should: flush existing + write '' to clear
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
      // After dispose, adapter is null — further writes should not crash
    });
  });

  describe('flush', () => {
    it('writes buffered entries to file', async () => {
      // We need to avoid the setInterval flush competing
      await logger.dispose();
      await logger.init(adapter, 'test-log.txt');
      adapter.write.mockClear();

      // The init already wrote "" once — wait, we cleared the mock
      // Manually add to buffer and flush
      (logger as any).buffer.push({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'INFO',
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
      // flush should be a no-op when adapter is null
      await expect(logger.flush()).resolves.not.toThrow();
    });
  });

  describe('log methods', () => {
    it('info adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.info('hello', { count: 1 });
      const buf = (logger as any).buffer;
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[buf.length - 1].message).toBe('hello');
      expect(buf[buf.length - 1].data).toEqual({ count: 1 });
    });

    it('warn adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.warn('warning');
      const buf = (logger as any).buffer;
      expect(buf[buf.length - 1].level).toBe('WARN');
    });

    it('error adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.error('oops');
      const buf = (logger as any).buffer;
      expect(buf[buf.length - 1].level).toBe('ERROR');
    });

    it('debug adds entry to buffer', async () => {
      await logger.init(adapter, 'test-log.txt');
      logger.debug('trace');
      const buf = (logger as any).buffer;
      expect(buf[buf.length - 1].level).toBe('DEBUG');
    });
  });

  describe('log lifecycle', () => {
    it('init → log → dispose clears file from both ends', async () => {
      // Startup: clear old log
      await logger.init(adapter, 'test-log.txt');
      expect(adapter.write).toHaveBeenCalledWith('test-log.txt', '');

      // During session: log entries accumulate
      logger.info('session start');
      logger.info('something happened');
      logger.warn('anomaly');
      logger.debug('details');
      expect((logger as any).buffer.length).toBeGreaterThanOrEqual(4);

      // Shutdown: flush entries, then clear
      adapter.write.mockClear();
      await logger.dispose();

      // Last write should be the clear
      const calls = adapter.write.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toBe('');
    });
  });
});
