// FIX: Provide a basic type declaration for the .mjs module.
declare module 'pdfjs-dist/build/pdf.mjs' {
    const pdfjsLib: any;
    export = pdfjsLib;
}

declare module 'pdfjs-dist/build/pdf.worker.mjs' {
    const workerSource: string;
    export default workerSource;
}

declare module '*.md' {
    const content: string;
    export default content;
}
