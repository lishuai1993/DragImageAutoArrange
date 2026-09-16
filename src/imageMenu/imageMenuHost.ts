import type { App } from 'obsidian';
import { logger } from '../logger';
import {
  coerceSettings,
  LEGACY_DATA_KEY,
  migrateLegacySettings,
  type ImageMenuSettings,
} from './settingsModel';

const log = logger.channel('imageMenu');

/** DIAA 数据对象里承载图片菜单设置的那把键，与顶层 DIAA 设置互不干扰。 */
export const IMAGE_MENU_DATA_KEY = 'imageMenu';

/** 设置存储需要的最小插件表面。 */
export interface ImageMenuOwner {
  app: App;
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 图片菜单设置的内存 + 持久化载体。
 *
 * 设置住在 DIAA 的数据对象里、单独占一把键，因此保存时必须「读出-改键-写回」
 * 而不是整体覆盖：顶层还存着 DIAA 自己的设置，覆盖会把它们抹掉。写盘串成一
 * 条队列，落盘顺序即调用顺序，避免并发写相互覆盖。
 *
 * 首次载入时若只找到改名前的那把键，就把旧设置迁移过来并顺手删掉旧键——删除
 * 与写入在同一次 saveData 里完成，迁移因此是一次性的。
 */
class SettingsStore {
  settings!: ImageMenuSettings;

  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly owner: ImageMenuOwner) {}

  async load(): Promise<void> {
    const data = await this.owner.loadData();
    const bag = isRecord(data) ? data : {};

    const stored = bag[IMAGE_MENU_DATA_KEY];
    if (stored !== undefined) {
      this.settings = coerceSettings(stored);
      return;
    }

    const legacy = bag[LEGACY_DATA_KEY];
    if (legacy === undefined) {
      this.settings = coerceSettings(undefined);
      return;
    }

    this.settings = migrateLegacySettings(legacy);
    log.info('LOG_IMAGE_MENU_SETTINGS_MIGRATED', { key: IMAGE_MENU_DATA_KEY });
    await this.persist(bag);
  }

  save(): Promise<void> {
    return this.enqueueSave();
  }

  private enqueueSave(): Promise<void> {
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        const data = await this.owner.loadData();
        await this.persist(isRecord(data) ? data : {});
      })
      .catch(error => {
        log.error('LOG_IMAGE_MENU_SETTINGS_SAVE_FAILED', { error: String(error) });
      });
    return this.saveQueue;
  }

  /** 写入当前键并抹掉旧键——旧键只在迁移窗口存在，之后每次保存都是空操作。 */
  private async persist(data: Record<string, unknown>): Promise<void> {
    data[IMAGE_MENU_DATA_KEY] = this.settings;
    delete data[LEGACY_DATA_KEY];
    await this.owner.saveData(data);
  }
}

/**
 * 图片菜单能力的入口：拿着它就能读设置、改设置，并把 app 交给各个操作函数。
 * 所有具体能力（复制、链接改写、文件操作）都是无状态函数，按需传入 `app` 与
 * `settings` 调用。
 */
export class ImageMenuFacade {
  readonly app: App;

  private readonly store: SettingsStore;

  constructor(owner: ImageMenuOwner) {
    this.app = owner.app;
    this.store = new SettingsStore(owner);
  }

  get settings(): ImageMenuSettings {
    return this.store.settings;
  }

  /** Same value as `settings`, as the settings-section bridge reads it. */
  getSettings(): ImageMenuSettings {
    return this.store.settings;
  }

  saveSettings(): Promise<void> {
    return this.store.save();
  }

  /** 载入持久化设置并返回可用门面。 */
  static async create(owner: ImageMenuOwner): Promise<ImageMenuFacade> {
    const facade = new ImageMenuFacade(owner);
    await facade.store.load();
    return facade;
  }
}

/** 创建并载入图片菜单门面。 */
export function createImageMenuFacade(owner: ImageMenuOwner): Promise<ImageMenuFacade> {
  return ImageMenuFacade.create(owner);
}
