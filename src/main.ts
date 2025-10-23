import { Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { getFirstPdfPageAsJpg, initPdfWorker } from './pdfUtils'; // Ensure the module is included
import { extractExifData, type ExifSummary } from './exifUtils';
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

    private normalizeVaultPath(path: string | undefined): string {
        if (!path) return '';
        const unified = path.trim().replace(/\\/g, '/');
        const withoutLeading = unified.replace(/^\/+/, '');
        const withoutTrailing = withoutLeading.replace(/\/+$/, '');
        return withoutTrailing;
    }

    public normalizeFolderPath(path: string | undefined): string {
        return this.normalizeVaultPath(path);
    }

    public normalizeFolderList(input: unknown): string[] {
        if (!input) return [];
        const source = Array.isArray(input)
            ? input
            : typeof input === 'string'
                ? input.split(/\r?\n|[,;]/g)
                : [];
        const normalized = (source as unknown[])
            .map(entry => typeof entry === 'string' ? this.normalizeFolderPath(entry) : '')
            .filter((entry): entry is string => !!entry);
        const unique = Array.from(new Set(normalized));
        unique.sort((a, b) => a.localeCompare(b));
        return unique;
    }

    private isPathWithinFolder(filePath: string, folderPath: string): boolean {
        const normalizedFolder = this.normalizeFolderPath(folderPath);
        if (!normalizedFolder) return true;
        const fileLower = this.normalizeVaultPath(filePath).toLowerCase();
        const folderLower = normalizedFolder.toLowerCase();
        if (fileLower === folderLower) return true;
        const prefix = `${folderLower}/`;
        return fileLower.startsWith(prefix);
    }

    private getAllowedFolders(kind: MediaKind): string[] {
        if (kind === 'image') return this.settings.imageSourceFolders ?? [];
        if (kind === 'pdf') return this.settings.pdfSourceFolders ?? [];
        return this.settings.otherSourceFolders ?? [];
    }

    private isSourceAllowed(file: TFile, kind: MediaKind): boolean {
        const allowed = this.getAllowedFolders(kind);
        if (!allowed || allowed.length === 0) return true;
        const filePath = this.normalizeVaultPath(file.path);
        return allowed.some(folder => this.isPathWithinFolder(filePath, folder));
    }

    private computePrimaryNotePath(file: TFile, kind: MediaKind, folder: string): { baseName: string; notePath: string } {
        const folderPath = this.normalizeFolderPath(folder);
        if (this.settings.useSuffix) {
            const suffixSource = file.extension ? file.extension : kind;
            const suffix = suffixSource.toLowerCase();
            const baseName = `${file.basename}.${suffix}`;
            const prefix = folderPath ? `${folderPath}/` : '';
            const notePath = `${prefix}${baseName}.md`;
            
            return { baseName, notePath };
        } else {
            const prefixSource = file.extension ? file.extension : kind;
            const prefix = prefixSource.toUpperCase();
            const suffix = prefixSource.toLowerCase();
            const baseName = `${prefix}-${file.basename}`;
            const folderPrefix = folderPath ? `${folderPath}/` : '';
            const notePath = `${folderPrefix}${baseName}.md`;
            return { baseName, notePath };
        }
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
        const folderPath = this.normalizeFolderPath(folder);
        const prefix = folderPath ? `${folderPath}/` : '';
        while (true) {
            const candidate = `${prefix}${baseName} (copy ${idx}).md`;
            if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
            idx++;
        }
    }

    // Utility: ensure the target folder exists
    private async ensureFolderExists(folder: string): Promise<void> {
        const normalized = this.normalizeFolderPath(folder);
        if (!normalized) return;
        if (this.ensuredFolders.has(normalized)) return;

        const parent = normalized.split('/').slice(0, -1).join('/');
        if (parent && parent !== normalized) {
            await this.ensureFolderExists(parent);
        }

        try {
            if (!this.app.vault.getAbstractFileByPath(normalized)) {
                await this.app.vault.createFolder(normalized);
            }
        } catch (e: any) {
            const msg = typeof e === 'string' ? e : e?.message;
            if (!msg || !/\balready exists\b/i.test(msg)) {
                console.error('Failed to ensure folder exists', normalized, e);
            }
        }
        this.ensuredFolders.add(normalized);
    }

    // Utility: detect already-exists errors
    private isAlreadyExistsError(e: any): boolean {
        const msg = typeof e === 'string' ? e : e?.message;
        return !!(msg && /\balready exists\b/i.test(msg));
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

    private async getMediaNotes(file: TFile, kind: MediaKind): Promise<TFile[]> {
        let folderSetting = this.getTargetFolder(kind);
        if (!folderSetting || !folderSetting.trim()) {
            folderSetting = file.parent?.path ?? '';
        }
        if (folderSetting == null) return [];
        const folder = this.normalizeFolderPath(folderSetting);
        const { baseName, notePath } = this.computePrimaryNotePath(file, kind, folder);
        const matches: TFile[] = [];

        const primary = this.app.vault.getAbstractFileByPath(notePath);
        if (primary instanceof TFile) {
            const status = await this.noteStatus(notePath, file.path);
            if (status === 'matches') {
                matches.push(primary);
            }
        }

        const candidates = this.app.vault.getFiles().filter(candidate => {
            const parentPath = this.normalizeFolderPath(candidate.parent?.path ?? '');
            if (parentPath !== folder) return false;
            if (candidate.path === notePath) return true;
            if (candidate.basename === baseName) return true;
            return candidate.basename.startsWith(`${baseName} (`);
        });

        for (const candidate of candidates) {
            if (matches.some(existing => existing.path === candidate.path)) continue;
            const status = await this.noteStatus(candidate.path, file.path);
            if (status === 'matches') {
                matches.push(candidate);
            }
        }

        return matches;
    }

    public async getIndexNotePath(file: TFile): Promise<string | null> {
        const kind = this.resolveKind(file);
        if (!kind) return null;
        const notes = await this.getMediaNotes(file, kind);
        return notes.length > 0 ? notes[0].path : null;
    }

    private formatExposureTime(exposure?: number): string {
        if (exposure == null || !Number.isFinite(exposure) || exposure <= 0) {
            return '';
        }
        if (exposure >= 1) {
            const rounded = Math.round(exposure * 10) / 10;
            return Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(1)}`;
        }
        const reciprocal = 1 / exposure;
        const roundedDenominator = Math.round(reciprocal);
        if (roundedDenominator > 0) {
            const approx = 1 / roundedDenominator;
            const relativeError = Math.abs(approx - exposure) / exposure;
            if (relativeError <= 0.02) {
                return `1/${roundedDenominator}`;
            }
        }
        const rounded = Math.round(exposure * 1000) / 1000;
        return `${rounded}`;
    }

    private async buildNoteContent(file: TFile, kind: MediaKind, duplicate = false): Promise<string> {
        const template = await this.loadTemplate(kind);
        const created = dateCreated();
        const filePath = file.path;
        let coverLink = filePath;
        let exifData: ExifSummary | null = null;

        if (kind === 'pdf' ) {
            const folder = this.settings.pdfFirstPageFolder;
            coverLink = await this.extractPdfFirstPage(file, folder) || '';
        } else if (kind === 'image') {
            try {
                const binary = await this.app.vault.readBinary(file);
                exifData = await extractExifData(binary);
            } catch (error) {
                console.warn('Failed to load EXIF data for', file.path, error);
            }
        }
        const urlProperty = this.settings.fileLinkProperty || 'url';
        const coverProperty = this.settings.coverLinkProperty || 'cover';
        let exifJson = '';
        if (exifData?.raw) {
            try {
                exifJson = JSON.stringify(exifData.raw);
            } catch (error) {
                console.warn('Failed to stringify EXIF data for', file.path, error);
            }
        }
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
            exifJson,
            exifCameraMaker: exifData?.maker ?? '',
            exifCameraModel: exifData?.model ?? '',
            exifLensModel: exifData?.lensModel ?? '',
            exifTakenAt: exifData?.takenAt ?? '',
            exifExposureTime: this.formatExposureTime(exifData?.exposureTime),
            exifFNumber: exifData?.fNumber != null ? `${exifData.fNumber}` : '',
            exifIso: exifData?.iso != null ? `${exifData.iso}` : '',
            exifFocalLength: exifData?.focalLength != null ? `${exifData.focalLength}` : '',
            exifFocalLength35mm: exifData?.focalLengthIn35mm != null ? `${exifData.focalLengthIn35mm}` : '',
            exifLatitude: exifData?.latitude != null ? `${exifData.latitude}` : '',
            exifLongitude: exifData?.longitude != null ? `${exifData.longitude}` : '',
            exifAltitude: exifData?.altitude != null ? `${exifData.altitude}` : '',
        };
        let rendered = this.applyExifBlock(template, replacements);
        for (const key in replacements) {
            if (!Object.prototype.hasOwnProperty.call(replacements, key)) continue;
            const value = replacements[key];
            const regex = new RegExp(`{{${key}}}`, 'g');
            rendered = rendered.replace(regex, value);
        }
        return rendered;
    }

    private applyExifBlock(template: string, replacements: Record<string, string>): string {
        return template.replace(/\{exif\}([\s\S]*?)\{\/exif\}/g, (_match, block: string) => {
            const lines = block.split('\n');
            const kept: string[] = [];
            const pending: string[] = [];
            let hasData = false;

            for (const line of lines) {
                const matches = Array.from(line.matchAll(/\{\{([^}]+)\}\}/g));
                if (matches.length === 0) {
                    if (hasData) {
                        kept.push(line);
                    } else {
                        pending.push(line);
                    }
                    continue;
                }

                const allFilled = matches.every(([, rawKey]) => {
                    const key = rawKey.trim();
                    const value = replacements[key];
                    return typeof value === 'string' && value.trim().length > 0;
                });

                if (allFilled) {
                    if (!hasData) {
                        kept.push(...pending);
                        pending.length = 0;
                    }
                    hasData = true;
                    kept.push(line);
                }
            }

            if (!hasData) {
                return '';
            }

            return kept.join('\n').replace(/\n+$/g, '');
        });
    }

    private async openOrCreateMediaNote(file: TFile, kind: MediaKind, force = false): Promise<void> {
        let targetFolder = this.getTargetFolder(kind) ?? '';
        if (!targetFolder.trim()) {
            targetFolder = file.parent?.path ?? '';
        }
        targetFolder = this.normalizeFolderPath(targetFolder);

        if (!force && !this.isSourceAllowed(file, kind)) {
            const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
            new Notice(`Media note creation is limited to the configured ${kindLabel} folders.`);
            return;
        }

        try {
            await this.processMedia(file, kind, targetFolder, { force });
        } catch (error) {
            console.error('Failed to create media note', file.path, error);
            new Notice('Failed to create media note. See console for details.');
            return;
        }

        const existingPath = await this.getIndexNotePath(file);
        const fallbackPath = existingPath ?? this.computePrimaryNotePath(file, kind, targetFolder).notePath;
        const target = this.app.vault.getAbstractFileByPath(fallbackPath);
        if (target instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(target);
        } else {
            new Notice('Media note created but could not be opened.');
        }
    }

    private async deleteMediaNotes(file: TFile, kind: MediaKind): Promise<void> {
        const notes = await this.getMediaNotes(file, kind);
        if (notes.length === 0) {
            new Notice('No media note found for this file.');
            return;
        }
        let deleted = 0;
        for (const note of notes) {
            try {
                await this.app.vault.delete(note);
                deleted++;
            } catch (error) {
                console.error('Failed to delete media note', note.path, error);
            }
        }
        if (deleted === 0) {
            new Notice('Failed to delete media note. See console for details.');
        } else {
            new Notice(deleted === 1 ? 'Media note deleted.' : `${deleted} media notes deleted.`);
        }
    }

    private getLinkPropertyValue(file: TFile): string | null {
        const key = (this.settings.fileLinkProperty || 'url').trim() || 'url';
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
        if (!frontmatter) return null;
        let raw = frontmatter[key];
        if (Array.isArray(raw)) {
            raw = raw.find(entry => typeof entry === 'string' && entry.trim().length > 0) ?? raw[0];
        }
        if (typeof raw === 'number' || typeof raw === 'boolean') {
            raw = String(raw);
        }
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private getReferencedSource(file: TFile): { type: 'url'; value: string } | { type: 'file'; value: TFile } | null {
        const raw = this.getLinkPropertyValue(file);
        if (!raw) return null;
        const trimmed = raw.replace(/^"|"$/g, '').trim();
        if (!trimmed) return null;

        const wiki = trimmed.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/);
        if (wiki) {
            const link = wiki[1].trim();
            if (link) {
                const target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
                if (target) return { type: 'file', value: target };
            }
        }

        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
            return { type: 'url', value: trimmed };
        }

        const byPath = this.app.vault.getAbstractFileByPath(trimmed);
        if (byPath instanceof TFile) {
            return { type: 'file', value: byPath };
        }

        const resolved = this.app.metadataCache.getFirstLinkpathDest(trimmed, file.path);
        if (resolved) {
            return { type: 'file', value: resolved };
        }

        return null;
    }

    private async openReferencedSource(file: TFile): Promise<void> {
        const target = this.getReferencedSource(file);
        if (!target) {
            new Notice('No referenced source found.');
            return;
        }
        if (target.type === 'url') {
            window.open(target.value, '_blank', 'noopener');
            return;
        }
        await this.app.workspace.getLeaf(false).openFile(target.value);
    }

    private async createNotesForFolder(folder: TFolder): Promise<void> {
        const queue: TAbstractFile[] = [...(folder.children ?? [])];
        const targets: Array<{ file: TFile; kind: MediaKind }> = [];

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
            if (current instanceof TFolder) {
                queue.unshift(...(current.children ?? []));
                continue;
            }
            if (!(current instanceof TFile)) continue;
            const kind = this.resolveKind(current);
            if (!kind) continue;
            targets.push({ file: current, kind });
        }

        if (targets.length === 0) {
            new Notice('No supported media files found in this folder.');
            return;
        }

        new Notice(`Processing ${targets.length} media file${targets.length === 1 ? '' : 's'}...`);
        for (const { file, kind } of targets) {
            try {
                const folderSetting = this.getTargetFolder(kind) ?? '';
                await this.processMedia(file, kind, folderSetting, { force: true });
            } catch (error) {
                console.error('Failed to process media file', file.path, error);
            }
        }
        new Notice('Folder scan complete. Media notes updated.');
    }

    // Utility: create or copy a note for a media file (shared by commands and event handler)
    public async processMedia(file: TFile, kind: MediaKind, targetFolder: string, options?: { force?: boolean }): Promise<void> {
        if (!targetFolder || !targetFolder.trim()) {    
            targetFolder = file.parent?.path || '';
        }
        const force = options?.force === true;
        if (!force && !this.isSourceAllowed(file, kind)) {
            return;
        }
        targetFolder = this.normalizeFolderPath(targetFolder);
        if (targetFolder) {
            await this.ensureFolderExists(targetFolder);
        }
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
                const images = this.app.vault.getFiles().filter(file =>
                    this.matchesExtension(file.extension, 'image') && this.isSourceAllowed(file, 'image')
                );
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
                const pdfs = this.app.vault.getFiles().filter(file =>
                    this.matchesExtension(file.extension, 'pdf') && this.isSourceAllowed(file, 'pdf')
                );
                const folder = this.settings.pdfNoteFolder;
                for (const pdf of pdfs) {
                    try { await this.processMedia(pdf, 'pdf', folder); } catch (e) { console.error('Failed processing pdf', pdf.path, e); }
                }
                new Notice('Scan complete. PDF notes updated.');
            }
        });

        this.addCommand({
            id: 'scan-other-media-and-create-notes',
            name: 'Scan other media and create notes',
            callback: async () => {
                const extensions = this.getExtensions('other');
                if (extensions.length === 0) {
                    new Notice('No extensions configured for other digital assets.');
                    return;
                }
                new Notice('Scanning digital assets...');
                const assets = this.app.vault.getFiles().filter(file =>
                    this.matchesExtension(file.extension, 'other') && this.isSourceAllowed(file, 'other')
                );
                const folder = this.settings.otherDigitalAssetsNoteFolder;
                for (const asset of assets) {
                    try { await this.processMedia(asset, 'other', folder); } catch (e) { console.error('Failed processing asset', asset.path, e); }
                }
                new Notice('Scan complete. Digital asset notes updated.');
            }
        });

        this.addCommand({
            id: 'create-media-note-for-active-file',
            name: 'Create or view media note for current file',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    return false;
                }
                const kind = this.resolveKind(file);
                if (!kind) {
                    return false;
                }
                if (checking) {
                    return true;
                }
                void this.openOrCreateMediaNote(file, kind, true);
                return true;
            },
        });

        this.addCommand({
            id: 'delete-media-note-for-active-file',
            name: 'Delete media note for current file',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    return false;
                }
                const kind = this.resolveKind(file);
                if (!kind) {
                    return false;
                }
                if (checking) {
                    return true;
                }
                void this.deleteMediaNotes(file, kind);
                return true;
            },
        });

        this.addCommand({
            id: 'create-media-notes-in-current-folder',
            name: 'Create media notes for all media files in current folder',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                const folder = file ? this.app.vault.getAbstractFileByPath(file.parent?.path ?? '') : null;
                const currentFolder = folder instanceof TFolder ? folder : file?.parent ?? null;
                if (!currentFolder) {
                    return false;
                }
                if (checking) {
                    return true;
                }
                void this.createNotesForFolder(currentFolder);
                return true;
            },
        });

        this.addCommand({
            id: 'open-referenced-source-for-active-note',
            name: 'Open referenced source for current note',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    return false;
                }
                if (file.extension?.toLowerCase() !== 'md') {
                    return false;
                }
                const reference = this.getReferencedSource(file);
                if (!reference) {
                    return false;
                }
                if (checking) {
                    return true;
                }
                void this.openReferencedSource(file);
                return true;
            },
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
                    if (!this.isSourceAllowed(file, 'image')) {
                        return;
                    }
                    const folder = this.settings.imageNoteFolder;
                    await this.processMedia(file, 'image', folder);
                    return;
                }

                if (isPdf) {
                    if (!this.isSourceAllowed(file, 'pdf')) {
                        return;
                    }
                    const folder = this.settings.pdfNoteFolder;
                    await this.processMedia(file, 'pdf', folder);
                    return;
                }

                if (isOther) {
                    if (!this.isSourceAllowed(file, 'other')) {
                        return;
                    }
                    const folder = this.settings.otherDigitalAssetsNoteFolder;
                    if (!folder) return;
                    await this.processMedia(file, 'other', folder);
                }
            } catch (e) {
                console.error('Auto note creation failed for', file?.path, e);
            }
        }));

        this.addSettingTab(new ImageNoteSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-menu', (menu, abstract) => {
            if (abstract instanceof TFile) {
                const file = abstract;
                const actions: Array<{ title: string; handler: () => Promise<void> | void }> = [];

                const kind = this.resolveKind(file);
                if (kind) {
                    let noteFolder = this.getTargetFolder(kind) ?? '';
                    if (!noteFolder.trim()) {
                        noteFolder = file.parent?.path ?? '';
                    }
                    const normalizedFolder = this.normalizeFolderPath(noteFolder);
                    const { baseName, notePath } = this.computePrimaryNotePath(file, kind, normalizedFolder);

                    const candidateExists = this.app.vault.getFiles().some(candidate => {
                        const candidateFolder = this.normalizeFolderPath(candidate.parent?.path ?? '');
                        if (candidateFolder !== normalizedFolder) return false;
                        if (candidate.path === notePath) return true;
                        if (candidate.basename === baseName) return true;
                        return candidate.basename.startsWith(`${baseName} (`);
                    });

                    if (candidateExists) {
                        actions.push({
                            title: 'Open Media Note',
                            handler: async () => {
                                const pathToOpen = await this.getIndexNotePath(file);
                                if (!pathToOpen) {
                                    new Notice('No media note found for this file.');
                                    return;
                                }
                                const target = this.app.vault.getAbstractFileByPath(pathToOpen);
                                if (target instanceof TFile) {
                                    await this.app.workspace.getLeaf(false).openFile(target);
                                }
                            },
                        });
                        actions.push({
                            title: 'Delete Media Note',
                            handler: async () => {
                                await this.deleteMediaNotes(file, kind);
                            },
                        });
                    } else {
                        actions.push({
                            title: 'Create Media Note',
                            handler: async () => {
                                await this.openOrCreateMediaNote(file, kind, true);
                            },
                        });
                    }

                    if (kind === 'pdf') {
                        actions.push({
                            title: 'Extract first page as image',
                            handler: async () => {
                                const folderPath = this.settings.pdfFirstPageFolder;
                                await this.extractPdfFirstPage(file, folderPath, true);
                            },
                        });
                    }
                }

                if (file.parent instanceof TFolder) {
                    actions.push({
                        title: 'Create Media Notes in Folder',
                        handler: async () => {
                            await this.createNotesForFolder(file.parent as TFolder);
                        },
                    });
                }

                if (file.extension?.toLowerCase() === 'md') {
                    const reference = this.getReferencedSource(file);
                    if (reference) {
                        actions.push({
                            title: 'Open referenced source',
                            handler: async () => {
                                await this.openReferencedSource(file);
                            },
                        });
                    }
                }

                if (actions.length > 0) {
                    menu.addItem(item => {
                        item.setTitle('Media Notes');
                        const sub = (item as any).setSubmenu();
                        for (const action of actions) {
                            sub.addItem((subItem: any) => {
                                subItem.setTitle(action.title);
                                subItem.onClick(() => { void action.handler(); });
                            });
                        }
                    });
                }
            } else if (abstract instanceof TFolder) {
                menu.addItem(item => {
                    item.setTitle('Media Notes');
                    const sub = (item as any).setSubmenu();
                    sub.addItem((subItem: any) => {
                        subItem.setTitle('Create Media Notes in Folder');
                        subItem.onClick(() => { void this.createNotesForFolder(abstract); });
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
        this.settings.imageSourceFolders = this.normalizeFolderList((stored as any)?.imageSourceFolders);
        this.settings.pdfSourceFolders = this.normalizeFolderList((stored as any)?.pdfSourceFolders);
        this.settings.otherSourceFolders = this.normalizeFolderList((stored as any)?.otherSourceFolders);
        this.clearTemplateCache();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
