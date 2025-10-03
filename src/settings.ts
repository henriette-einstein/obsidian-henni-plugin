import { App, Notice, PluginSettingTab, Setting, SuggestModal, TextComponent, TFile } from 'obsidian';
import type HenniPlugin from './main';
import type { MediaKind } from './main';

export interface HenniPluginSettings {
    imageNoteFolder: string;
    pdfNoteFolder: string;
    pdfFirstPageFolder: string;
    otherDigitalAssetsNoteFolder: string;
    autoCreateOnFileAdd: boolean;
    fileLinkProperty: string;
    coverLinkProperty: string;
    imageExtensions: string[];
    pdfExtensions: string[];
    otherExtensions: string[];
    imageTemplatePath: string;
    pdfTemplatePath: string;
    otherTemplatePath: string;
}

export const DEFAULT_SETTINGS: HenniPluginSettings = {
    imageNoteFolder: '60 Bibliothek/Bilder',
    pdfNoteFolder: '60 Bibliothek/PDFs',
    pdfFirstPageFolder: '80 Medien/Bilder/PDF Covers',
    otherDigitalAssetsNoteFolder: '60 Bibliothek/Medien',
    autoCreateOnFileAdd: false,
    fileLinkProperty: 'url',
    coverLinkProperty: 'cover',
    imageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'],
    pdfExtensions: ['pdf'],
    otherExtensions: ['xls', 'docx', 'ppt'],
    imageTemplatePath: '',
    pdfTemplatePath: '',
    otherTemplatePath: '',
};

export class ImageNoteSettingTab extends PluginSettingTab {
    private readonly plugin: HenniPlugin;

    constructor(app: App, plugin: HenniPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const joinExtensions = (extensions: string[] | undefined) => (extensions?.join(', ') ?? '');
        const parseExtensions = (input: string) => {
            const parts = input
                .split(/[\s,;]+/)
                .map(part => part.trim().replace(/^\./, '').toLowerCase())
                .filter(Boolean);
            return Array.from(new Set(parts));
        };
        const matchesExtension = (extension: string | undefined, extensions: string[]) => {
            if (!extension) return false;
            return extensions.includes(extension.toLowerCase());
        };
        const setWide = (component: TextComponent) => {
            component.inputEl.style.width = '320px';
        };

        containerEl.createEl('h3', { text: 'General Settings' });

        new Setting(containerEl)
            .setName('Auto-create notes on add')
            .setDesc('Automatically create notes when adding supported files to the vault.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoCreateOnFileAdd)
                .onChange(async (value) => {
                    this.plugin.settings.autoCreateOnFileAdd = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Media link property name')
            .setDesc('YAML property that stores the media link (default: url).')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.fileLinkProperty)
                    .setValue(this.plugin.settings.fileLinkProperty || DEFAULT_SETTINGS.fileLinkProperty)
                    .onChange(async (value) => {
                        const trimmed = value?.trim() || DEFAULT_SETTINGS.fileLinkProperty;
                        this.plugin.settings.fileLinkProperty = trimmed;
                        this.plugin.clearTemplateCache();
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        new Setting(containerEl)
            .setName('Cover link property name')
            .setDesc('YAML property that stores the link to the cover image (default: cover).')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.coverLinkProperty)
                    .setValue(this.plugin.settings.coverLinkProperty || DEFAULT_SETTINGS.coverLinkProperty)
                    .onChange(async (value) => {
                        const trimmed = value?.trim() || DEFAULT_SETTINGS.coverLinkProperty;
                        this.plugin.settings.coverLinkProperty = trimmed;
                        this.plugin.clearTemplateCache();
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

            containerEl.createEl('h3', { text: 'Images' });

        new Setting(containerEl)
            .setName('Image note folder')
            .setDesc('Folder where new image notes will be created. Leave empty to use the path of the original image.')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.imageNoteFolder)
                    .setValue(this.plugin.settings.imageNoteFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.imageNoteFolder = value;
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        new Setting(containerEl)
            .setName('Image extensions')
            .setDesc('Comma-separated list of extensions (case-insensitive without dots) treated as images.')
            .addText(text => {
                text
                    .setPlaceholder(joinExtensions(DEFAULT_SETTINGS.imageExtensions))
                    .setValue(joinExtensions(this.plugin.settings.imageExtensions))
                    .onChange(async (value) => {
                        this.plugin.settings.imageExtensions = parseExtensions(value);
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        const imageTemplateSetting = new Setting(containerEl)
            .setName('Image template path')
            .setDesc('Optional vault-relative path to the template used for image notes. Leave empty to use the bundled templates.');
        let imageTemplateText: TextComponent;
        imageTemplateSetting.addText(text => {
            imageTemplateText = text;
            text
                .setPlaceholder('Leave empty to use the bundled image template')
                .setValue(this.plugin.settings.imageTemplatePath || '')
                .onChange(async (value) => {
                    this.plugin.settings.imageTemplatePath = value?.trim() || '';
                    this.plugin.clearTemplateCache('image');
                    await this.plugin.saveSettings();
                });
            setWide(text);
        });
        imageTemplateSetting.addExtraButton(btn => {
            btn.setIcon('folder-open');
            btn.setTooltip('Browse templates');
            btn.onClick(() => {
                new TemplatePickerModal(this.app, (file) => {
                    const path = file.path;
                    imageTemplateText!.setValue(path);
                    this.plugin.settings.imageTemplatePath = path;
                    this.plugin.clearTemplateCache('image');
                    void this.plugin.saveSettings();
                }, 'image').open();
            });
        });

        new Setting(containerEl)
            .setName('Create Image Notes Now')
            .setDesc('Scans configured image extensions and creates notes in the image folder.')
            .addButton(btn => btn
                .setButtonText('Run')
                .onClick(async () => {
                    try {
                        const extensions = this.plugin.settings.imageExtensions ?? [];
                        if (extensions.length === 0) {
                            new Notice('No image extensions configured.');
                            return;
                        }
                        new Notice('Scanning images...');
                        const images = this.app.vault.getFiles().filter(file => matchesExtension(file.extension, extensions));
                        const folder = this.plugin.settings.imageNoteFolder;
                        for (const image of images) {
                            try {
                                await this.plugin.processMedia(image, 'image', folder);
                            } catch (e) {
                                console.error('Failed processing image', image.path, e);
                            }
                        }
                        new Notice('Scan complete. Image notes updated.');
                    } catch (e) {
                        console.error('Failed to run image note creation command', e);
                    }
                }));

        containerEl.createEl('h3', { text: 'PDFs' });

        new Setting(containerEl)
            .setName('PDF note folder')
            .setDesc('Folder where new PDF notes will be created. Leave empty to use the path of the original PDF.')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.pdfNoteFolder)
                    .setValue(this.plugin.settings.pdfNoteFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.pdfNoteFolder = value;
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        new Setting(containerEl)
            .setName('PDF first page image folder')
            .setDesc('Folder where images of the first page of the PDF will be created. Leave empty to use the path of the original PDF.')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.pdfFirstPageFolder)
                    .setValue(this.plugin.settings.pdfFirstPageFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.pdfFirstPageFolder = value;
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        new Setting(containerEl)
            .setName('PDF extensions')
            .setDesc('Comma-separated list of extensions treated as PDFs.')
            .addText(text => {
                text
                    .setPlaceholder(joinExtensions(DEFAULT_SETTINGS.pdfExtensions))
                    .setValue(joinExtensions(this.plugin.settings.pdfExtensions))
                    .onChange(async (value) => {
                        this.plugin.settings.pdfExtensions = parseExtensions(value);
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        const pdfTemplateSetting = new Setting(containerEl)
            .setName('PDF template path')
            .setDesc('Optional vault-relative path to the template used for PDF notes. Leave empty to use the bundled template.');
        let pdfTemplateText: TextComponent;
        pdfTemplateSetting.addText(text => {
            pdfTemplateText = text;
            text
                .setPlaceholder('Leave empty to use the bundled PDF template')
                .setValue(this.plugin.settings.pdfTemplatePath || '')
                .onChange(async (value) => {
                    this.plugin.settings.pdfTemplatePath = value?.trim() || '';
                    this.plugin.clearTemplateCache('pdf');
                    await this.plugin.saveSettings();
                });
            setWide(text);
        });
        pdfTemplateSetting.addExtraButton(btn => {
            btn.setIcon('folder-open');
            btn.setTooltip('Browse templates');
            btn.onClick(() => {
                new TemplatePickerModal(this.app, (file) => {
                    const path = file.path;
                    pdfTemplateText!.setValue(path);
                    this.plugin.settings.pdfTemplatePath = path;
                    this.plugin.clearTemplateCache('pdf');
                    void this.plugin.saveSettings();
                }, 'pdf').open();
            });
        });

        new Setting(containerEl)
            .setName('Create PDF Notes Now')
            .setDesc('Scans configured PDF extensions (case-insensitive without dots) and creates notes in the PDF folder.')
            .addButton(btn => btn
                .setButtonText('Run')
                .onClick(async () => {
                    try {
                        const extensions = this.plugin.settings.pdfExtensions ?? [];
                        if (extensions.length === 0) {
                            new Notice('No PDF extensions configured.');
                            return;
                        }
                        new Notice('Scanning PDFs...');
                        const pdfs = this.app.vault.getFiles().filter(file => matchesExtension(file.extension, extensions));
                        const folder = this.plugin.settings.pdfNoteFolder;
                        for (const pdf of pdfs) {
                            try {
                                await this.plugin.processMedia(pdf, 'pdf', folder);
                            } catch (e) {
                                console.error('Failed processing pdf', pdf.path, e);
                            }
                        }
                        new Notice('Scan complete. PDF notes updated.');
                    } catch (e) {
                        console.error('Failed to run PDF note creation command', e);
                    }
                }));

        containerEl.createEl('h3', { text: 'Other Digital Assets' });

        new Setting(containerEl)
            .setName('Target folder')
            .setDesc('Folder where notes for other digital assets will be created. Leave empty to use the path of the original assets.')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.otherDigitalAssetsNoteFolder ?? '')
                    .setValue(this.plugin.settings.otherDigitalAssetsNoteFolder || '')
                    .onChange(async (value) => {
                        this.plugin.settings.otherDigitalAssetsNoteFolder = value;
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        new Setting(containerEl)
            .setName('Other extensions')
            .setDesc('Comma-separated list of extensions (case-insensitive without dots) handled as other digital assets.')
            .addText(text => {
                text
                    .setPlaceholder(joinExtensions(DEFAULT_SETTINGS.otherExtensions))
                    .setValue(joinExtensions(this.plugin.settings.otherExtensions))
                    .onChange(async (value) => {
                        this.plugin.settings.otherExtensions = parseExtensions(value);
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });

        const otherTemplateSetting = new Setting(containerEl)
            .setName('Other assets template path')
            .setDesc('Optional vault-relative path to the template used for other digital asset notes. Leave empty to use the bundled template.');
        let otherTemplateText: TextComponent;
        otherTemplateSetting.addText(text => {
            otherTemplateText = text;
            text
                .setPlaceholder('Leave empty to use the bundled template')
                .setValue(this.plugin.settings.otherTemplatePath || '')
                .onChange(async (value) => {
                    this.plugin.settings.otherTemplatePath = value?.trim() || '';
                    this.plugin.clearTemplateCache('other');
                    await this.plugin.saveSettings();
                });
            setWide(text);
        });
        otherTemplateSetting.addExtraButton(btn => {
            btn.setIcon('folder-open');
            btn.setTooltip('Browse templates');
            btn.onClick(() => {
                new TemplatePickerModal(this.app, (file) => {
                    const path = file.path;
                    otherTemplateText!.setValue(path);
                    this.plugin.settings.otherTemplatePath = path;
                    this.plugin.clearTemplateCache('other');
                    void this.plugin.saveSettings();
                }, 'other').open();
            });
        });

        new Setting(containerEl)
            .setName('Create Media Notes Now')
            .setDesc('Scans configured other extensions and creates notes in the target folder.')
            .addButton(btn => btn
                .setButtonText('Run')
                .onClick(async () => {
                    try {
                        const extensions = this.plugin.settings.otherExtensions ?? [];
                        if (extensions.length === 0) {
                            new Notice('No extensions configured for other digital assets.');
                            return;
                        }
                        const folder = this.plugin.settings.otherDigitalAssetsNoteFolder;
                        new Notice('Scanning digital assets...');
                        const assets = this.app.vault.getFiles().filter(file => matchesExtension(file.extension, extensions));
                        for (const asset of assets) {
                            try {
                                await this.plugin.processMedia(asset, 'other', folder);
                            } catch (e) {
                                console.error('Failed processing asset', asset.path, e);
                            }
                        }
                        new Notice('Scan complete. Digital asset notes updated.');
                    } catch (e) {
                        console.error('Failed to run other asset note creation command', e);
                    }
                }));


    }
}

class TemplatePickerModal extends SuggestModal<TFile> {
    private readonly onChoose: (file: TFile) => void;
    private readonly kind: MediaKind;

    constructor(app: App, onChoose: (file: TFile) => void, kind: MediaKind) {
        super(app);
        this.onChoose = onChoose;
        this.kind = kind;
        this.setPlaceholder(`Select ${kind} template file`);
    }

    getSuggestions(query: string): TFile[] {
        const lower = query.toLowerCase();
        return this.app.vault.getFiles()
            .filter(file => file.extension.toLowerCase() === 'md')
            .filter(file => file.path.toLowerCase().includes(lower))
            .slice(0, 100);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.createEl('div', { text: file.path });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(file);
    }
}
