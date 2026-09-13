// Mock for the obsidian module in tests. The `Menu`/`Setting` callbacks are
// never invoked here — their signatures mirror Obsidian's own so the mocked
// surface stays assignable from real call sites. `import type` is erased at
// runtime, so this self-referential type import does not create a cycle.
import type * as obsidian from "obsidian";

export const Menu = class {
  addItem(_cb: (item: obsidian.MenuItem) => unknown) { return this; }
  addSeparator() { return this; }
  showAtMouseEvent(_event: MouseEvent) {}
};

export const Plugin = class {};
export const MarkdownView = class {};
export const PluginSettingTab = class {};
export const Setting = class {
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  addToggle(_cb: (component: obsidian.ToggleComponent) => unknown) { return this; }
  addSlider(_cb: (component: obsidian.SliderComponent) => unknown) { return this; }
  addDropdown(_cb: (component: obsidian.DropdownComponent) => unknown) { return this; }
  addText(_cb: (component: obsidian.TextComponent) => unknown) { return this; }
  addButton(_cb: (component: obsidian.ButtonComponent) => unknown) { return this; }
};
export const App = class {};
export const TFile = class {};
export const Modal = class {
  open() {}
  close() {}
};
export const MarkdownPostProcessorContext = class {};
export const DataAdapter = class {};
export const editorLivePreviewField = {};

// Extra surface used by the image-menu modules and the settings tab.
export const getLanguage = () => 'en';
export const Platform = { isMacOS: true, isMobile: false, isDesktopApp: true };
export const setIcon = () => {};
export const addIcon = () => {};
export const getIcon = () => null;
export const Notice = class {};
export const ButtonComponent = class {};
export const ExtraButtonComponent = class {};
export const FileSystemAdapter = class {};
export const TextComponent = class {};
export const ToggleComponent = class {};
export const DropdownComponent = class {};
export const SliderComponent = class {};
