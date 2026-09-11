import { type App, Modal, type TFile } from 'obsidian';
import { MODAL_TEXT } from './menuTexts';

/** 重命名图像：输入新文件名，确认后回调；取消回调 null。 */
export class RenameImageModal extends Modal {
  constructor(
    app: App,
    private readonly originalName: string,
    private readonly onSubmit: (result: string | null) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('pixel-perfect-rename-modal');

    contentEl.createEl('h2', { text: MODAL_TEXT.rename.title, cls: 'modal-title' });

    const form = contentEl.createEl('form', { cls: 'pixel-perfect-rename-form' });
    const input = form.createEl('input', {
      type: 'text',
      value: this.originalName,
      cls: 'pixel-perfect-rename-input',
    });

    // 选中文件名主体，扩展名留给用户自己决定改不改。
    const lastDotIndex = this.originalName.lastIndexOf('.');
    if (lastDotIndex > 0) {
      input.setSelectionRange(0, lastDotIndex);
    }

    const buttonContainer = form.createDiv({ cls: 'pixel-perfect-button-container' });
    buttonContainer.createEl('button', {
      text: MODAL_TEXT.rename.renameButton,
      type: 'submit',
      cls: 'mod-cta',
    });

    buttonContainer
      .createEl('button', { text: MODAL_TEXT.rename.cancelButton, type: 'button' })
      .addEventListener('click', () => {
        this.onSubmit(null);
        this.close();
      });

    form.addEventListener('submit', event => {
      event.preventDefault();
      const newName = input.value.trim();
      this.onSubmit(newName && newName !== this.originalName ? newName : null);
      this.close();
    });

    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 删除图像前的确认框；确认后回调 `onConfirm`。 */
export class DeleteImageConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly file: TFile,
    private readonly onConfirm: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('pixel-perfect-delete-modal');

    contentEl.createEl('h2', { text: MODAL_TEXT.delete.title, cls: 'modal-title' });

    const messageDiv = contentEl.createDiv({ cls: 'pixel-perfect-delete-message' });
    messageDiv.createEl('p', {
      text: MODAL_TEXT.delete.confirmMessage.replace('{filename}', this.file.name),
    });
    messageDiv.createEl('p', { text: MODAL_TEXT.delete.warningMessage, cls: 'mod-warning' });

    const buttonContainer = contentEl.createDiv({ cls: 'pixel-perfect-button-container' });
    buttonContainer
      .createEl('button', { text: MODAL_TEXT.delete.deleteButton, cls: 'mod-warning' })
      .addEventListener('click', () => {
        this.onConfirm();
        this.close();
      });
    const cancelButton = buttonContainer.createEl('button', {
      text: MODAL_TEXT.delete.cancelButton,
    });
    cancelButton.addEventListener('click', () => this.close());

    // 默认聚焦取消，误按回车不会删文件。
    cancelButton.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
