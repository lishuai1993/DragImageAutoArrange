import type { App } from 'obsidian';
import { logger } from '../logger';
import {
  coerceSettings,
  type PixelPerfectImageSettings,
} from './ppSettingsModel';

const log = logger.channel('ppHost');

/** DIA 数据对象里承载图片菜单设置的那把键，与顶层 DIA 设置互不干扰。 */
export const PP_DATA_KEY = 'pixelPerfectImage';

/** 设置存储需要的最小插件表面。 */
export interface PixelPerfectOwner {
  app: App;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

/**
 * 图片菜单设置的内存 + 持久化载体。
 *
 * 设置住在 DIA 的数据对象里、单独占一把键，因此保存时必须「读出-改键-写回」
 * 而不是整体覆盖：顶层还存着 DIA 自己的设置，覆盖会把它们抹掉。写盘串成一
 * 条队列，落盘顺序即调用顺序，避免并发写相互覆盖。
 */
class SettingsStore {
  settings!: PixelPerfectImageSettings;

  private saveQueue: Promise<void> = Promise.resolve();
  private debounceTimer: number | null = null;
  private debouncedPromise: Promise<void> | null = null;
  private debouncedResolve: (() => void) | null = null;

  constructor(private readonly owner: PixelPerfectOwner) {}

  async load(): Promise<void> {
    const data = await this.owner.loadData();
    const stored =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)[PP_DATA_KEY]
        : undefined;
    this.settings = coerceSettings(stored);
  }

  save(): Promise<void> {
    return this.enqueueSave();
  }

  /**
   * 延迟落盘：设置页里连续输入（如尺寸预设逐字符敲）时，只在停下 250ms 后
   * 写一次。返回的 Promise 在本次落盘完成后兑现，调用方可 await。
   */
  requestSave(debounceMs = 250): Promise<void> {
    if (!this.debouncedPromise) {
      this.debouncedPromise = new Promise<void>(resolve => {
        this.debouncedResolve = resolve;
      });
    }
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueueSave()
        .then(() => this.debouncedResolve?.())
        .finally(() => {
          this.debouncedPromise = null;
          this.debouncedResolve = null;
        });
    }, debounceMs);
    return this.debouncedPromise;
  }

  private enqueueSave(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const data = (await this.owner.loadData()) ?? {};
        (data as Record<string, unknown>)[PP_DATA_KEY] = this.settings;
        await this.owner.saveData(data);
      })
      .catch(error => {
        log.error('LOG_PP_SETTINGS_SAVE_FAILED', { error: String(error) });
      });
    return this.saveQueue;
  }
}

/**
 * 图片菜单能力的入口：拿着它就能读设置、改设置，并把 app 交给各个操作函数。
 * 所有具体能力（复制、缩放、文件操作、链接改写）都是无状态的纯函数，按需
 * 传入 `app` 与 `settings` 调用。
 */
export class PixelPerfectFacade {
  readonly app: App;

  private readonly store: SettingsStore;

  constructor(owner: PixelPerfectOwner) {
    this.app = owner.app;
    this.store = new SettingsStore(owner);
  }

  get settings(): PixelPerfectImageSettings {
    return this.store.settings;
  }

  saveSettings(): Promise<void> {
    return this.store.save();
  }

  requestSaveSettings(debounceMs?: number): Promise<void> {
    return this.store.requestSave(debounceMs);
  }

  /** 载入持久化设置并返回可用门面。 */
  static async create(owner: PixelPerfectOwner): Promise<PixelPerfectFacade> {
    const facade = new PixelPerfectFacade(owner);
    await facade.store.load();
    return facade;
  }
}

/** 创建并载入图片菜单门面。 */
export function createPixelPerfectFacade(owner: PixelPerfectOwner): Promise<PixelPerfectFacade> {
  return PixelPerfectFacade.create(owner);
}
