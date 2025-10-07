declare module 'exifr' {
    type ExifrSource = ArrayBuffer | Uint8Array | Blob | Buffer;

    interface ParseOptions {
        pick?: readonly string[];
        [key: string]: unknown;
    }

    interface ExifrModule {
        parse(source: ExifrSource, options?: ParseOptions): Promise<Record<string, unknown> | undefined>;
    }

    const exifr: ExifrModule;
    export default exifr;
}
