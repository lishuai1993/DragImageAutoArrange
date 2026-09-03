import type { App, EventRef, PluginManifest } from 'obsidian';
import type { FileService } from './core/FileService';
import type { ImageService } from './core/ImageService';
import type { LinkService } from './core/LinkService';
import type { PixelPerfectImageSettings } from './ui/settings';

/**
 * The minimal surface of the Pixel Perfect Image plugin that its services
 * depend on. Both the standalone `PixelPerfectImage` plugin class and the
 * in-process host that DragImageAutoArrange provides structurally satisfy it,
 * so the service classes can be driven from either.
 */
export interface PixelPerfectImageHost {
    app: App;
    manifest: PluginManifest;
    settings: PixelPerfectImageSettings;
    imageService: ImageService;
    linkService: LinkService;
    fileService: FileService;
    registerEvent(eventRef: EventRef): void;
    saveSettings(): Promise<void>;
    requestSaveSettings(debounceMs?: number): Promise<void>;
}
