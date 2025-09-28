import { App, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type HenniPlugin from './main';

export interface HenniPluginSettings {
    imageNoteFolder: string;
    pdfNoteFolder: string;
    othetDigitalAssetsNoteFolder?: string;
    autoCreateOnFileAdd: boolean;
    fileLinkProperty: string;
    imageExtensions: string[];
    pdfExtensions: string[];
    otherExtensions: string[];
}

export const DEFAULT_SETTINGS: HenniPluginSettings = {
    imageNoteFolder: '60 Bibliothek/Bilder',
    pdfNoteFolder: '60 Bibliothek/PDFs',
    othetDigitalAssetsNoteFolder: '60 Bibliothek/MediMedianMen',
    autoCreateOnFileAdd: false,
    fileLinkProperty: 'url',
    imageExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'],
    pdfExtensions: ['pdf'],
    otherExtensions: ['xls', 'docx', 'ppt'],
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

        containerEl.createEl('h3', { text: 'Images' });

        new Setting(containerEl)
            .setName('Image note folder')
            .setDesc('Folder where new image notes will be created.')
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
            .setDesc('Folder where new PDF notes will be created.')
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
            .setDesc('Folder where notes for other digital assets will be created.')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.othetDigitalAssetsNoteFolder ?? '')
                    .setValue(this.plugin.settings.othetDigitalAssetsNoteFolder || '')
                    .onChange(async (value) => {
                        this.plugin.settings.othetDigitalAssetsNoteFolder = value;
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
                        const folder = this.plugin.settings.othetDigitalAssetsNoteFolder;
                        if (!folder) {
                            new Notice('No target folder configured for other digital assets.');
                            return;
                        }
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
            .setName('YAML property for file link')
            .setDesc('Name of the YAML property that stores the linked file path (default: url).')
            .addText(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.fileLinkProperty)
                    .setValue(this.plugin.settings.fileLinkProperty || DEFAULT_SETTINGS.fileLinkProperty)
                    .onChange(async (value) => {
                        this.plugin.settings.fileLinkProperty = value?.trim() || DEFAULT_SETTINGS.fileLinkProperty;
                        await this.plugin.saveSettings();
                    });
                setWide(text);
            });
    }
}
