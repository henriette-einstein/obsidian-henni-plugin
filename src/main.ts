import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, ImageNoteSettingTab, type HenniPluginSettings } from './settings';

// Helper to format created date
const formatCreated = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

export default class HenniPlugin extends Plugin {
    settings: HenniPluginSettings;
    private ensuredFolders: Set<string> = new Set();

    private normalizeExtensions(value: unknown, fallback: string[]): string[] {
        const source = Array.isArray(value)
            ? value
            : typeof value === 'string'
                ? value.split(/[\s,;]+/)
                : fallback;
        const normalized = source
            .map(entry => typeof entry === 'string' ? entry.trim().replace(/^\./, '').toLowerCase() : '')
            .filter(Boolean);
        if (!Array.isArray(value) && typeof value !== 'string' && normalized.length === 0) {
            return [...fallback];
        }
        return Array.from(new Set(normalized));
    }

    public getExtensions(kind: 'image' | 'pdf' | 'other'): string[] {
        if (kind === 'image') return this.settings.imageExtensions;
        if (kind === 'pdf') return this.settings.pdfExtensions;
        return this.settings.otherExtensions;
    }

    private matchesExtension(extension: string | undefined, kind: 'image' | 'pdf' | 'other'): boolean {
        if (!extension) return false;
        const ext = extension.toLowerCase();
        return this.getExtensions(kind).includes(ext);
    }

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
    private buildNoteContent(filePath: string, kind: 'image' | 'pdf' | 'other', duplicate = false): string {
        const created = formatCreated();
        const prop = this.settings.fileLinkProperty || 'url';
        const tags = kind === 'image'
            ? 'type/image'
            : kind === 'pdf'
                ? 'type/pdf'
                : 'type/digital-asset';
        const typeLine = kind === 'image'
            ? 'type: "[[Bilder]]"\n'
            : kind === 'pdf'
                ? 'type: "[[PDFs]]"\n'
                : '';
        const dupLine = duplicate ? 'duplicate: true\n' : '';
        return `---\n${prop}: "[[${filePath}]]"\n${typeLine}tags: ${tags}\ncreated: ${created}\n${dupLine}---\n![[${filePath}]]\n`;
    }

    // Utility: create or copy a note for a media file (shared by commands and event handler)
    public async processMedia(file: TFile, kind: 'image' | 'pdf' | 'other', targetFolder: string): Promise<void> {
        await this.ensureFolderExists(targetFolder);
        const prefix = (file.extension ? file.extension : kind).toUpperCase();
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
                const extensions = this.getExtensions('image');
                if (extensions.length === 0) {
                    new Notice('No image extensions configured.');
                    return;
                }
                new Notice('Scanning images...');
                const images = this.app.vault.getFiles().filter(file => this.matchesExtension(file.extension, 'image'));
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
                const extensions = this.getExtensions('pdf');
                if (extensions.length === 0) {
                    new Notice('No PDF extensions configured.');
                    return;
                }
                new Notice('Scanning PDFs...');
                const pdfs = this.app.vault.getFiles().filter(file => this.matchesExtension(file.extension, 'pdf'));
                const folder = this.settings.pdfNoteFolder;
                for (const pdf of pdfs) {
                    try { await this.processMedia(pdf, 'pdf', folder); } catch (e) { console.error('Failed processing pdf', pdf.path, e); }
                }
                new Notice('Scan complete. PDF notes updated.');
            }
        });

		// Auto-create notes when supported files are added to the vault
		this.registerEvent(this.app.vault.on('create', async (file) => {
			if (!(file instanceof TFile)) return;
			if (!this.settings.autoCreateOnFileAdd) return;
			const ext = file.extension;
			const isImage = this.matchesExtension(ext, 'image');
			const isPdf = this.matchesExtension(ext, 'pdf');
			const isOther = this.matchesExtension(ext, 'other');
			if (!isImage && !isPdf && !isOther) return; // ignore unsupported files (and avoids loops on created .md)

            try {
                if (isImage) {
                    const folder = this.settings.imageNoteFolder;
                    await this.processMedia(file, 'image', folder);
                    return;
                }

                if (isPdf) {
                    const folder = this.settings.pdfNoteFolder;
                    await this.processMedia(file, 'pdf', folder);
                    return;
                }

                if (isOther) {
                    const folder = this.settings.othetDigitalAssetsNoteFolder;
                    if (!folder) return;
                    await this.processMedia(file, 'other', folder);
                }
            } catch (e) {
                console.error('Auto note creation failed for', file?.path, e);
            }
        }));

		this.addSettingTab(new ImageNoteSettingTab(this.app, this));
	}

	async loadSettings() {
		const stored = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		this.settings.imageExtensions = this.normalizeExtensions((stored as any)?.imageExtensions, DEFAULT_SETTINGS.imageExtensions);
		this.settings.pdfExtensions = this.normalizeExtensions((stored as any)?.pdfExtensions, DEFAULT_SETTINGS.pdfExtensions);
		this.settings.otherExtensions = this.normalizeExtensions((stored as any)?.otherExtensions, DEFAULT_SETTINGS.otherExtensions);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
