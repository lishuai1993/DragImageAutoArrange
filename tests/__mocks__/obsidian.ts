// Mock for the obsidian module in tests
export const Menu = class {
  addItem(_cb: (item: any) => any) { return this; }
  addSeparator() { return this; }
  showAtMouseEvent(_event: MouseEvent) {}
};

export const Plugin = class {};
export const MarkdownView = class {};
export const PluginSettingTab = class {};
export const Setting = class {
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  addToggle(_cb: (toggle: any) => any) { return this; }
  addSlider(_cb: (slider: any) => any) { return this; }
  addDropdown(_cb: (dropdown: any) => any) { return this; }
  addText(_cb: (text: any) => any) { return this; }
  addButton(_cb: (button: any) => any) { return this; }
};
export const App = class {};
export const TFile = class {};
export const MarkdownPostProcessorContext = class {};
export const DataAdapter = class {};
export const editorLivePreviewField = {};

// Extra surface used by the vendored Pixel Perfect runtime / i18n loader.
export const getLanguage = () => 'en';
export const Platform = { isMacOS: true, isMobile: false };
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
