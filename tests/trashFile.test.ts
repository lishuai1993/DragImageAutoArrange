/**
 * Tests for the trash wrapper's false-failure guard.
 *
 * Obsidian's macOS trash chain can move a file to the OS trash and still throw
 * (`trashSystem` reports a falsy IPC result, so `Vault.trash` falls through to
 * `trashLocal`, which renames a source that is already gone). The wrapper must
 * read the filesystem, not the error, to tell that apart from a real failure.
 */
import { describe, it, expect, vi } from 'vitest';
import type { App, TAbstractFile } from 'obsidian';
import { trashFile } from '../src/utils';

const file = { path: 'assets/a.png' } as unknown as TAbstractFile;

function makeApp(opts: {
  trashFile?: (f: TAbstractFile) => Promise<void>;
  vaultTrash?: (f: TAbstractFile, system: boolean) => Promise<void>;
  exists?: (path: string) => Promise<boolean>;
} = {}): App {
  return {
    fileManager: opts.trashFile ? { trashFile: opts.trashFile } : {},
    vault: {
      adapter: { exists: opts.exists ?? (async () => true) },
      ...(opts.vaultTrash ? { trash: opts.vaultTrash } : {}),
    },
  } as unknown as App;
}

describe('trashFile', () => {
  it('resolves when the trash call succeeds', async () => {
    const trash = vi.fn(async () => {});
    await expect(trashFile(makeApp({ trashFile: trash }), file)).resolves.toBeUndefined();
    expect(trash).toHaveBeenCalledWith(file);
  });

  it('treats a throw as success when the file is gone', async () => {
    const app = makeApp({
      trashFile: async () => {
        throw new Error('ENOENT: no such file or directory');
      },
      exists: async () => false,
    });
    await expect(trashFile(app, file)).resolves.toBeUndefined();
  });

  it('rethrows when the file is still there', async () => {
    const failure = new Error('permission denied');
    const app = makeApp({
      trashFile: async () => {
        throw failure;
      },
      exists: async () => true,
    });
    await expect(trashFile(app, file)).rejects.toBe(failure);
  });

  it('rethrows when existence cannot be read', async () => {
    const failure = new Error('boom');
    const app = makeApp({
      trashFile: async () => {
        throw failure;
      },
      exists: async () => {
        throw new Error('adapter unavailable');
      },
    });
    await expect(trashFile(app, file)).rejects.toBe(failure);
  });

  it('falls back to Vault.trash on older builds', async () => {
    const vaultTrash = vi.fn(async () => {});
    await trashFile(makeApp({ vaultTrash }), file);
    expect(vaultTrash).toHaveBeenCalledWith(file, true);
  });

  it('applies the same guard on the Vault.trash fallback', async () => {
    const app = makeApp({
      vaultTrash: async () => {
        throw new Error('ENOENT');
      },
      exists: async () => false,
    });
    await expect(trashFile(app, file)).resolves.toBeUndefined();
  });

  it('throws when the build offers neither API', async () => {
    await expect(trashFile(makeApp(), file)).rejects.toThrow();
  });
});
