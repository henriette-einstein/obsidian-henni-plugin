// FIX: Provide a basic type declaration for the .mjs module.
declare module 'pdfjs-dist/build/pdf.mjs' {
    const pdfjsLib: any;
    export = pdfjsLib;
}