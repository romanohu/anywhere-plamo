import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfBlocks, type DocumentBlock } from './document-layout';

GlobalWorkerOptions.workerSrc = new URL('/pdfjs/pdf.worker.mjs', location.href).href;

export class LocalPdf {
  private task: PDFDocumentLoadingTask;
  private rendering?: RenderTask;

  constructor(data: ArrayBuffer) {
    this.task = getDocument({ data: new Uint8Array(data),
      cMapUrl: new URL('/pdfjs/cmaps/', location.href).href,
      standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.href).href,
      wasmUrl: new URL('/pdfjs/wasm/', location.href).href,
      useWasm: false, useWorkerFetch: true, isImageDecoderSupported: false,
      maxImageSize: 32 * 1024 * 1024, canvasMaxAreaInBytes: 32 * 1024 * 1024,
      enableXfa: false, verbosity: 0 });
  }

  async count(): Promise<number> { return (await this.task.promise).numPages; }

  async page(number: number, canvas: HTMLCanvasElement, rotation: number): Promise<DocumentBlock[]> {
    const page = await (await this.task.promise).getPage(number);
    try {
      const initial = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const viewport = page.getViewport({ scale: Math.min(3, 2048 / Math.max(initial.width, initial.height)), rotation: initial.rotation });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('ページを表示できません。');
      this.rendering = page.render({ canvas, canvasContext: context, viewport });
      await this.rendering.promise;
      const content = await page.getTextContent();
      return pdfBlocks(content.items.filter(item => 'str' in item), content.styles, viewport.transform, viewport.width, viewport.height);
    } finally { this.rendering = undefined; page.cleanup(); }
  }

  async destroy(): Promise<void> { this.rendering?.cancel(); await this.task.destroy(); }
}
