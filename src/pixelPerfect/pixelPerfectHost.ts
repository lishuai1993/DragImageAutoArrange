import type { App, EventRef, PluginManifest } from 'obsidian';
import { ImageService } from '../vendor/pixelPerfectImage/core/ImageService';
import { LinkService } from '../vendor/pixelPerfectImage/core/LinkService';
import { FileService } from '../vendor/pixelPerfectImage/core/FileService';
import { MenuService } from '../vendor/pixelPerfectImage/ui/MenuService';
import type { PixelPerfectImageHost } from '../vendor/pixelPerfectImage/PixelPerfectImageHost';
import {
    DEFAULT_SETTINGS,
    reconcileFileOperations,
    sanitizeResizeSizes,
    type PixelPerfectImageSettings
} from '../vendor/pixelPerfectImage/ui/settings';

/** Storage key inside the DragImageAutoArrange plugin data object that owns the
 *  Pixel Perfect Image settings, keeping them out of the top-level DIA keys. */
export const PP_DATA_KEY = 'pixelPerfectImage';

/** The minimal DragImageAutoArrange surface that the PP host needs to talk to. */
export interface PixelPerfectOwner {
    app: App;
    manifest: PluginManifest;
    registerEvent(eventRef: EventRef): void;
    loadData(): Promise<any>;
    saveData(data: any): Promise<void>;
}

/**
 * In-process host that lets the vendored Pixel Perfect Image services run inside
 * DragImageAutoArrange without instantiating PP's own `Plugin` lifecycle. PP
 * settings are persisted in the DIA data object under {@link PP_DATA_KEY}.
 */
export class PixelPerfectHostImpl implements PixelPerfectImageHost {
    app: App;
    manifest: PluginManifest;
    settings!: PixelPerfectImageSettings;
    imageService!: ImageService;
    linkService!: LinkService;
    fileService!: FileService;

    private saveQueue: Promise<void> = Promise.resolve();
    private debounceTimer: number | null = null;
    private debouncedPromise: Promise<void> | null = null;
    private debouncedResolve: (() => void) | null = null;

    constructor(private owner: PixelPerfectOwner) {
        this.app = owner.app;
        this.manifest = owner.manifest;
    }

    registerEvent(eventRef: EventRef): void {
        this.owner.registerEvent(eventRef);
    }

    /** Load PP settings from the shared DIA data namespace and wire services. */
    async load(): Promise<void> {
        const data = await this.owner.loadData();
        const stored =
            data && typeof data === 'object' && !Array.isArray(data)
                ? (data as Record<string, unknown>)[PP_DATA_KEY]
                : undefined;
        const settings = Object.assign({}, DEFAULT_SETTINGS, (stored ?? {}) as Partial<PixelPerfectImageSettings>);
        settings.fileOperations = reconcileFileOperations(settings.fileOperations);
        settings.customResizeSizes = sanitizeResizeSizes(
            Array.isArray(settings.customResizeSizes) ? settings.customResizeSizes : []
        );
        this.settings = settings;

        this.imageService = new ImageService(this);
        this.linkService = new LinkService(this);
        this.fileService = new FileService(this);
    }

    saveSettings(): Promise<void> {
        return this.enqueueSave();
    }

    requestSaveSettings(debounceMs = 250): Promise<void> {
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
            });
        return this.saveQueue;
    }
}

/** Everything the unified menu needs from the vendored PP runtime. */
export interface PixelPerfectFacade {
    host: PixelPerfectHostImpl;
    menuService: MenuService;
}

export async function createPixelPerfectFacade(owner: PixelPerfectOwner): Promise<PixelPerfectFacade> {
    const host = new PixelPerfectHostImpl(owner);
    await host.load();
    return { host, menuService: new MenuService(host) };
}
