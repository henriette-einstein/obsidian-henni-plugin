import { Notice, Plugin, TFile } from 'obsidian';
import { getFirstPdfPageAsJpg, initPdfWorker } from './pdfUtils'; // Ensure the module is included
import { DEFAULT_SETTINGS, ImageNoteSettingTab, type HenniPluginSettings } from './settings';
import imageTemplateContent from './templates/image-note-template.md';
import otherTemplateContent from './templates/other-note-template.md';
import pdfTemplateContent from './templates/pdf-note-template.md';

// Helper to format created date
const dateCreated = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

export type MediaKind = 'image' | 'pdf' | 'other';

export default class HenniPlugin extends Plugin {
    settings: HenniPluginSettings;
    private ensuredFolders: Set<string> = new Set();
    private templateCache: Partial<Record<MediaKind, string>> = {};
    private readonly bundledTemplates: Record<MediaKind, string> = {
        image: imageTemplateContent,
        pdf: pdfTemplateContent,
        other: otherTemplateContent,
    };

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

    public getExtensions(kind: MediaKind): string[] {
        if (kind === 'image') return this.settings.imageExtensions;
        if (kind === 'pdf') return this.settings.pdfExtensions;
        return this.settings.otherExtensions;
    }

    private matchesExtension(extension: string | undefined, kind: MediaKind): boolean {
        if (!extension) return false;
        const ext = extension.toLowerCase();
        return this.getExtensions(kind).includes(ext);
    }

    private resolveKind(file: TFile): MediaKind | null {
        const ext = file.extension?.toLowerCase();
        if (!ext) return null;
        if (this.settings.imageExtensions.includes(ext)) return 'image';
        if (this.settings.pdfExtensions.includes(ext)) return 'pdf';
        if (this.settings.otherExtensions.includes(ext)) return 'other';
        return null;
    }

    private getTargetFolder(kind: MediaKind): string | undefined {
        if (kind === 'image') return this.settings.imageNoteFolder;
        if (kind === 'pdf') return this.settings.pdfNoteFolder;
        return this.settings.otherDigitalAssetsNoteFolder;
    }

    private computePrimaryNotePath(file: TFile, kind: MediaKind, folder: string): { baseName: string; notePath: string } {
        const prefixSource = file.extension ? file.extension : kind;
        const prefix = prefixSource.toUpperCase();
        const baseName = `${prefix}-${file.basename}`;
        const notePath = `${folder}/${baseName}.md`;
        return { baseName, notePath };
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
        } catch (_) { }

        const key = (this.settings.fileLinkProperty || 'url').trim() || 'url';
        const normalizedKey = key.toLowerCase();
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
                const line = yaml.split('\n').find(l => l.replace(/^\s+/, '').toLowerCase().startsWith(`${normalizedKey}:`));
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
            const candidate = `${folder}/${baseName} (copy ${idx}).md`;
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

    private getUserTemplatePath(kind: MediaKind): string | undefined {
        const raw = kind === 'image'
            ? this.settings.imageTemplatePath
            : kind === 'pdf'
                ? this.settings.pdfTemplatePath
                : this.settings.otherTemplatePath;
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        return trimmed ? trimmed : undefined;
    }

    private async loadTemplate(kind: MediaKind): Promise<string> {
        const cached = this.templateCache[kind];
        if (cached) return cached;
        const userPath = this.getUserTemplatePath(kind);
        if (userPath) {
            try {
                const content = await this.app.vault.adapter.read(userPath);
                this.templateCache[kind] = content;
                return content;
            } catch (error) {
                console.error(`Failed to read custom ${kind} template at ${userPath}.`, error);
            }
        }
        const fallback = this.bundledTemplates[kind];
        this.templateCache[kind] = fallback;
        return fallback;
    }

    public clearTemplateCache(kind?: MediaKind): void {
        if (kind) {
            delete this.templateCache[kind];
        } else {
            this.templateCache = {};
        }
    }

    public async getIndexNotePath(file: TFile): Promise<string | null> {
        const kind = this.resolveKind(file);
        if (!kind) return null;
        const folder = this.getTargetFolder(kind);
        if (!folder) return null;

        const { baseName, notePath } = this.computePrimaryNotePath(file, kind, folder);
        const primaryStatus = await this.noteStatus(notePath, file.path);
        if (primaryStatus === 'matches') {
            return notePath;
        }

        const candidates = this.app.vault.getFiles().filter(candidate => {
            if (candidate.parent?.path !== folder) return false;
            if (candidate.path === notePath) return true;
            if (candidate.basename === baseName) return true;
            return candidate.basename.startsWith(`${baseName} (`);
        });

        for (const candidate of candidates) {
            if (candidate.path === notePath) {
                continue;
            }
            const status = await this.noteStatus(candidate.path, file.path);
            if (status === 'matches') {
                return candidate.path;
            }
        }

        return null;
    }

    private async buildNoteContent(file: TFile, kind: MediaKind, duplicate = false): Promise<string> {
        const template = await this.loadTemplate(kind);
        const created = dateCreated();
        const filePath = file.path;
        let coverLink = filePath
        if (kind === 'pdf' ) {
            const folder = this.settings.pdfFirstPageFolder;
            coverLink = await this.extractPdfFirstPage(file, folder) || '';
        }
        const urlProperty = this.settings.fileLinkProperty || 'url';
        const coverProperty = this.settings.coverLinkProperty || 'cover';
        const replacements: Record<string, string> = {
            date: created,
            urlProperty: urlProperty,
            coverProperty: coverProperty,
            cover: coverLink,
            url: filePath,
            duplicate: duplicate ? 'true' : 'false',
            basename: file.basename ?? '',
            extension: file.extension ?? '',
            folder: file.parent?.path ?? '',
            filesize: `${file.stat?.size ?? 0}`,
        };
        let rendered = template;
        for (const key in replacements) {
            if (!Object.prototype.hasOwnProperty.call(replacements, key)) continue;
            const value = replacements[key];
            const regex = new RegExp(`{{${key}}}`, 'g');
            rendered = rendered.replace(regex, value);
        }
        return rendered;
    }

    // Utility: create or copy a note for a media file (shared by commands and event handler)
    public async processMedia(file: TFile, kind: MediaKind, targetFolder: string): Promise<void> {
        if (!targetFolder || !targetFolder.trim()) {    
            targetFolder = file.parent?.path || '';
        }
        await this.ensureFolderExists(targetFolder);
        const { baseName, notePath } = this.computePrimaryNotePath(file, kind, targetFolder);

        const status = await this.noteStatus(notePath, file.path);
        if (status === 'matches') {
            return; // already correct
        }

        const existingMatchPath = await this.getIndexNotePath(file);
        if (existingMatchPath) {
            const existingNote = this.app.vault.getAbstractFileByPath(existingMatchPath);
            if (existingNote instanceof TFile) {
                const isCopy = existingMatchPath !== notePath;
                const content = await this.buildNoteContent(file, kind, isCopy);
                await this.app.vault.modify(existingNote, content);
                return;
            }
        }

        if (status === 'not-found') {
            try {
                const content = await this.buildNoteContent(file, kind, false);
                await this.app.vault.create(notePath, content);
            } catch (e) {
                if (!this.isAlreadyExistsError(e)) {
                    console.error('Failed to create base note', notePath, e);
                }
            }
            return;
        }
        for (let attempts = 0; attempts < 100; attempts++) {
            const copyPath = this.getNextCopyNotePath(targetFolder, baseName);
            try {
                const content = await this.buildNoteContent(file, kind, true);
                await this.app.vault.create(copyPath, content);
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

        console.log('Loading PDF First Page Extractor plugin...');

        try {
            // Call the initialization function from the utility file
            await initPdfWorker();
        } catch (error: any) {
            new Notice(error.message);
            return; // Stop loading if the worker fails
        }

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
                    const folder = this.settings.otherDigitalAssetsNoteFolder;
                    if (!folder) return;
                    await this.processMedia(file, 'other', folder);
                }
            } catch (e) {
                console.error('Auto note creation failed for', file?.path, e);
            }
        }));

        this.addSettingTab(new ImageNoteSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!(file instanceof TFile)) return;
            const kind = this.resolveKind(file);
            if (!kind) {
                return;
            }
            const folder = this.getTargetFolder(kind);
            if (!folder) {
                new Notice(`No target folder configured for ${kind} notes.`);
                return;
            }
            const { baseName, notePath } = this.computePrimaryNotePath(file, kind, folder);

            const candidateExists = this.app.vault.getFiles().some(candidate => {
                if (candidate.parent?.path !== folder) return false;
                if (candidate.path === notePath) return true;
                if (candidate.basename === baseName) return true;
                return candidate.basename.startsWith(`${baseName} (`);
            });

            if (candidateExists) {
                menu.addItem(item => {
                    item.setTitle('Open Media Note');
                    item.onClick(async () => {
                        const pathToOpen = await this.getIndexNotePath(file);
                        if (!pathToOpen) {
                            new Notice('No media note found for this file.');
                            return;
                        }
                        const target = this.app.vault.getAbstractFileByPath(pathToOpen);
                        if (target instanceof TFile) {
                            await this.app.workspace.getLeaf(false).openFile(target);
                        }
                    });
                });
            } else {
                menu.addItem(item => {
                    item.setTitle('Create Media Note');
                    item.onClick(async () => {
                        await this.processMedia(file, kind, folder);
                        const pathToOpen = await this.getIndexNotePath(file);
                        const target = pathToOpen ? this.app.vault.getAbstractFileByPath(pathToOpen) : this.app.vault.getAbstractFileByPath(notePath);
                        if (target instanceof TFile) {
                            await this.app.workspace.getLeaf(false).openFile(target);
                        }
                    });
                });
            }

            if (kind === 'pdf') {
                menu.addItem(item => {
                    item.setTitle('Extract first page as image');
                    item.onClick(async () => {
                        const folder = this.settings.pdfFirstPageFolder;
                        await this.extractPdfFirstPage(file, folder,true);
                    });
                });
            }
        }));
    }

    // Extract the first page of a PDF and save it as a JPG image in the same folder
    private async extractPdfFirstPage(file: TFile, targetFolder: string, verbose: boolean = false): Promise<string> {
        if (verbose) {
        new Notice(`Extracting first page from ${file.basename}...`);
        }
        try {
            const newFileName = `${file.basename}-page1.jpg`;
            const folder = targetFolder? targetFolder:file.parent?.path || '';
            const newFilePath = `${folder}/${newFileName}`;

            if (await this.app.vault.adapter.exists?.(newFilePath)) {
                if (verbose) {
                    new Notice(`File ${newFileName} already exists. Using existing image.`);
                }
                return newFilePath;
            }

            await this.ensureFolderExists(folder);
            const pdfBuffer = await this.app.vault.readBinary(file);
            const imageBuffer = await getFirstPdfPageAsJpg(pdfBuffer, 0.9, 2.0);

            await this.app.vault.createBinary(newFilePath, imageBuffer);
            if (verbose) {
                new Notice(`Successfully saved as ${newFileName}`);
            }
            return newFilePath

        } catch (error) {
            console.error('PDF Extraction Error:', error);
            new Notice('Failed to extract PDF page. See console for details.');
            return '';
        }
    }

    async loadSettings() {
        const stored = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        this.settings.imageExtensions = this.normalizeExtensions((stored as any)?.imageExtensions, DEFAULT_SETTINGS.imageExtensions);
        this.settings.pdfExtensions = this.normalizeExtensions((stored as any)?.pdfExtensions, DEFAULT_SETTINGS.pdfExtensions);
        this.settings.otherExtensions = this.normalizeExtensions((stored as any)?.otherExtensions, DEFAULT_SETTINGS.otherExtensions);
        this.settings.fileLinkProperty = typeof (stored as any)?.fileLinkProperty === 'string'
            ? (stored as any).fileLinkProperty.trim() || DEFAULT_SETTINGS.fileLinkProperty
            : DEFAULT_SETTINGS.fileLinkProperty;
        this.settings.imageTemplatePath = typeof (stored as any)?.imageTemplatePath === 'string' ? (stored as any).imageTemplatePath.trim() : '';
        this.settings.pdfTemplatePath = typeof (stored as any)?.pdfTemplatePath === 'string' ? (stored as any).pdfTemplatePath.trim() : '';
        this.settings.otherTemplatePath = typeof (stored as any)?.otherTemplatePath === 'string' ? (stored as any).otherTemplatePath.trim() : '';
        this.clearTemplateCache();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
