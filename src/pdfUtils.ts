import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import workerSource from 'pdfjs-dist/build/pdf.worker.mjs';

/**
 * Initializes the PDF.js worker so rendering works without touching the filesystem.
 */
export async function initPdfWorker(): Promise<void> {
    try {
        const workerBlob = new Blob([workerSource], { type: 'text/javascript' });
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
    } catch (error) {
        console.error("Failed to load PDF.js worker:", error);
        // Throw the error so the main file can handle the user notification
        throw new Error("PDF worker script could not be inlined.");
    }
}

/**
 * Extracts the first page of a PDF and returns it as a JPG image.
 * @param pdfData The PDF file content as an ArrayBuffer or Uint8Array.
 * @param quality The quality of the JPG image (0.0 to 1.0).
 * @param scale The rendering scale of the PDF page for higher resolution.
 * @returns A promise that resolves with the JPG image data as an ArrayBuffer.
 */
export async function getFirstPdfPageAsJpg(
    pdfData: ArrayBuffer | Uint8Array, 
    quality: number = 0.9, 
    scale: number = 2): Promise<ArrayBuffer> {
    const doc = await pdfjs.getDocument({ data: pdfData }).promise;

    if (doc.numPages < 1) {
        throw new Error('PDF has no pages.');
    }

    const page = await doc.getPage(1);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
        throw new Error('Could not create canvas context.');
    }
    
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const renderContext = {
        canvasContext: context,
        viewport: viewport,
    };
    await page.render(renderContext).promise;

    // The toDataURL method for JPEG takes a quality parameter.
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    return imageBuffer.buffer;
}
