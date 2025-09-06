import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface HenniPluginSettings {
	imageNoteFolder: string;
	pdfNoteFolder: string;
	autoCreateOnFileAdd: boolean;
    fileLinkProperty: string;
}

const DEFAULT_SETTINGS: HenniPluginSettings = {
	imageNoteFolder: '60 Bibliothek/Bilder',
	pdfNoteFolder: '60 Bibliothek/PDFs',
	autoCreateOnFileAdd: true,
    fileLinkProperty: 'url'
}

// Helper to format created date
const formatCreated = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

export default class HenniPlugin extends Plugin {
    settings: HenniPluginSettings;
    private ensuredFolders: Set<string> = new Set();

	// Utility: check if a note exists and whether it links to the given target via configured YAML property
    private async noteStatus(notePath: string, targetPath: string): Promise<'not-found' | 'matches' | 'exists-different'> {
        const abstract = this.app.vault.getAbstractFileByPath(notePath);
        if (!abstract) return 'not-found';
        if (!(abstract instanceof TFile)) return 'exists-different';
        // Guard against stale index entries: verify the file actually exists on disk
        try {
            const exists = await this.app.vault.adapter.exists(notePath);
            if (!exists) return 'not-found';
        } catch (_) {}

        const key = this.settings.fileLinkProperty || 'url';
        const compare = (raw: string | undefined): 'matches' | 'exists-different' => {
            if (!raw) return 'exists-different';
            const val = raw.trim().replace(/^"|"$/g, "");
            // Try wiki-link [[...]] resolution against the vault
            const wiki = val.match(/^\[\[([^\]]+)\]\]$/);
            if (wiki) {
                const inner = wiki[1];
                const resolved = this.app.metadataCache.getFirstLinkpathDest(inner, abstract.path);
                if (resolved && resolved.path === targetPath) return 'matches';
            }
            // Fallback direct compare
            if (val.toLowerCase() === targetPath.toLowerCase()) return 'matches';
            if (val.includes(targetPath)) return 'matches';
            return 'exists-different';
        };

        try {
            const cache = this.app.metadataCache.getFileCache(abstract);
            const front = (cache as any)?.frontmatter as any;
            const value = front?.[key] as string | undefined;
            const res = compare(value);
            if (res === 'matches') return 'matches';
        } catch (e) {
            console.error('Failed to evaluate note status (cache) for', notePath, e);
        }

        // Fallback: read YAML block to inspect the property if cache is stale
        try {
            const content = await this.app.vault.read(abstract);
            const yamlMatch = content.match(/^---[\s\S]*?---/);
            if (yamlMatch) {
                const yaml = yamlMatch[0];
                const line = yaml.split('\n').find(l => l.replace(/^\s+/, '').toLowerCase().startsWith(`${key.toLowerCase()}:`));
                if (line) {
                    const propVal = line.substring(line.indexOf(':') + 1).trim();
                    const res = compare(propVal);
                    if (res === 'matches') return 'matches';
                }
            }
        } catch (e) {
            console.error('Failed to evaluate note status (content) for', notePath, e);
        }
        return 'exists-different';
    }

	// Utility: compute next available copy note path like `${folder}/${baseName} (N copy).md`
    private getNextCopyNotePath(folder: string, baseName: string): string {
        let idx = 1;
        while (true) {
            const candidate = `${folder}/${baseName} (${idx} copy).md`;
            if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
            idx++;
        }
    }

    // Utility: ensure the target folder exists
    private async ensureFolderExists(folder: string): Promise<void> {
        if (this.ensuredFolders.has(folder)) return;
        try {
            if (!this.app.vault.getAbstractFileByPath(folder)) {
                await this.app.vault.createFolder(folder);
            }
        } catch (e: any) {
            const msg = typeof e === 'string' ? e : e?.message;
            if (!msg || !/exist/i.test(msg)) {
                console.error('Failed to ensure folder exists', folder, e);
            }
        }
        this.ensuredFolders.add(folder);
    }

    // Utility: detect already-exists errors
    private isAlreadyExistsError(e: any): boolean {
        const msg = typeof e === 'string' ? e : e?.message;
        return !!(msg && /exist/i.test(msg));
    }

    // Utility: build note content for a media file
    private buildNoteContent(filePath: string, kind: 'image' | 'pdf', duplicate = false): string {
        const created = formatCreated();
        const prop = this.settings.fileLinkProperty || 'url';
        const tags = kind === 'image' ? 'type/image' : 'type/pdf';
        const typeLine = kind === 'image' ? 'type: "[[Bilder]]"\n' : 'type: "[[PDFs]]"\n';
        const dupLine = duplicate ? 'duplicate: true\n' : '';
        return `---\n${prop}: "[[${filePath}]]"\n${typeLine}tags: ${tags}\ncreated: ${created}\n${dupLine}---\n![[${filePath}]]\n`;
    }

    // Utility: create or copy a note for a media file (shared by commands and event handler)
    public async processMedia(file: TFile, kind: 'image' | 'pdf', targetFolder: string): Promise<void> {
        await this.ensureFolderExists(targetFolder);
        const prefix = kind === 'image' ? 'IMG' : 'PDF';
        const baseName = `${prefix}-${file.basename}`;
        const notePath = `${targetFolder}/${baseName}.md`;

        const status = await this.noteStatus(notePath, file.path);
        if (status === 'not-found') {
            try {
                await this.app.vault.create(notePath, this.buildNoteContent(file.path, kind, false));
            } catch (e) {
                if (!this.isAlreadyExistsError(e)) {
                    console.error('Failed to create base note', notePath, e);
                }
            }
            return;
        }
        if (status === 'matches') {
            return; // already correct
        }
        for (let attempts = 0; attempts < 100; attempts++) {
            const copyPath = this.getNextCopyNotePath(targetFolder, baseName);
            try {
                await this.app.vault.create(copyPath, this.buildNoteContent(file.path, kind, true));
                break;
            } catch (e) {
                if (this.isAlreadyExistsError(e)) {
                    continue; // try next available name
                }
                console.error('Failed to create copy note', copyPath, e);
                break;
            }
        }
    }

	async onload() {
		await this.loadSettings();


		this.addCommand({
			id: 'scan-images-and-create-imagenote',
			name: 'Scan images and create image notes',
            callback: async () => {
                new Notice('Scanning images...');
                const images = this.app.vault.getFiles().filter(file => {
                    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(file.extension.toLowerCase());
                });
                const folder = this.settings.imageNoteFolder;
                for (const image of images) {
                    try { await this.processMedia(image, 'image', folder); } catch (e) { console.error('Failed processing image', image.path, e); }
                }
                new Notice('Scan complete. Image notes updated.');
            }
        });

		// PDF scan and note creation
		this.addCommand({
			id: 'scan-pdfs-and-create-pdfnote',
			name: 'Scan PDFs and create PDF notes',
            callback: async () => {
                new Notice('Scanning PDFs...');
                const pdfs = this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === 'pdf');
                const folder = this.settings.pdfNoteFolder;
                for (const pdf of pdfs) {
                    try { await this.processMedia(pdf, 'pdf', folder); } catch (e) { console.error('Failed processing pdf', pdf.path, e); }
                }
                new Notice('Scan complete. PDF notes updated.');
            }
        });

		// Auto-create notes when images or PDFs are added to the vault
		this.registerEvent(this.app.vault.on('create', async (file) => {
			if (!(file instanceof TFile)) return;
			if (!this.settings.autoCreateOnFileAdd) return;
			const ext = file.extension?.toLowerCase();
			const isImage = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext);
			const isPdf = ext === 'pdf';
			if (!isImage && !isPdf) return; // ignore non-media files (and avoids loops on created .md)

            try {
                if (isImage) {
                    const folder = this.settings.imageNoteFolder;
                    await this.processMedia(file, 'image', folder);
                }

                if (isPdf) {
                    const folder = this.settings.pdfNoteFolder;
                    await this.processMedia(file, 'pdf', folder);
                }
            } catch (e) {
                console.error('Auto note creation failed for', file?.path, e);
            }
        }));

		this.addSettingTab(new ImageNoteSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ImageNoteSettingTab extends PluginSettingTab {
	plugin: HenniPlugin;

	constructor(app: App, plugin: HenniPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

		display(): void {
			const {containerEl} = this;

			containerEl.empty();

			new Setting(containerEl)
				.setName('Image Note Folder')
				.setDesc('The folder where new image notes will be created.')
				.addText(text => text
					.setPlaceholder('Enter the folder name')
					.setValue(this.plugin.settings.imageNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.imageNoteFolder = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('PDF Note Folder')
				.setDesc('The folder where new PDF notes will be created.')
				.addText(text => text
					.setPlaceholder('Enter the folder name')
					.setValue(this.plugin.settings.pdfNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.pdfNoteFolder = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Auto-create notes on add')
				.setDesc('Automatically create notes when adding images or PDFs to the vault.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoCreateOnFileAdd)
					.onChange(async (value) => {
						this.plugin.settings.autoCreateOnFileAdd = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('YAML property for file link')
				.setDesc('Name of the YAML property that stores the linked file path (default: url).')
				.addText(text => text
					.setPlaceholder('url')
					.setValue(this.plugin.settings.fileLinkProperty || 'url')
					.onChange(async (value) => {
						this.plugin.settings.fileLinkProperty = value?.trim() || 'url';
						await this.plugin.saveSettings();
					}));

			// Actions
			new Setting(containerEl)
				.setName('Create Image Notes Now')
				.setDesc('Scans images and creates notes in the configured image folder.')
				.addButton(btn => btn
					.setButtonText('Run')
					.onClick(async () => {
						try {
                            // Directly call the command logic instead of using app.commands
                            new Notice('Scanning images...');
                            const images = this.app.vault.getFiles().filter(file => {
                                return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(file.extension.toLowerCase());
                            });
                            const folder = this.plugin.settings.imageNoteFolder;
                            for (const image of images) {
                                try { await this.plugin.processMedia(image, 'image', folder); } catch (e) { console.error('Failed processing image', image.path, e); }
                            }
                            new Notice('Scan complete. Image notes updated.');
						} catch (e) {
							console.error('Failed to run image note creation command', e);
						}
					}));

			new Setting(containerEl)
				.setName('Create PDF Notes Now')
				.setDesc('Scans PDFs and creates notes in the configured PDF folder.')
				.addButton(btn => btn
					.setButtonText('Run')
					.onClick(async () => {
						try {
                            new Notice('Scanning PDFs...');
                            const pdfs = this.app.vault.getFiles().filter(file => file.extension.toLowerCase() === 'pdf');
                            const folder = this.plugin.settings.pdfNoteFolder;
                            for (const pdf of pdfs) {
                                try { await this.plugin.processMedia(pdf, 'pdf', folder); } catch (e) { console.error('Failed processing pdf', pdf.path, e); }
                            }
                            new Notice('Scan complete. PDF notes updated.');
						} catch (e) {
							console.error('Failed to run PDF note creation command', e);
						}
					}));
		}
}
