export interface NativeParseResult {
  text: string;                      // native text + OCR text merged
  charCount: number;
  pageCount?: number;                // pages (PDF), slides (PPTX), sheets (XLSX — not printed pages)
  metadata: Record<string, string>;  // Author, Creation-Date, Title, Company
  headingsFromStructure: string[];   // <h1>-<h6> (DOCX), scored signals (PDF), title placeholders (PPTX)
  tableCount: number;                // <table> (DOCX), <a:tbl> (PPTX), 0 for PDF/XLSX
  imageCount: number;
  scannedPageRatio: number;          // PDF only; 0 for all others
  scannedPageIndices: number[];      // PDF only; [] for all others
  ocrPageCount: number;              // images/pages that had tesseract run
}
