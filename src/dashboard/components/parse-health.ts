import { formatPercent } from '../lib/formatters.js';

export interface ReportData {
  summary: { totalFiles: number; parsedFiles: number };
  parsed?: Array<{ filename: string }>;
  consistencyChecks?: Record<string, { value: number; pass?: boolean }>;
}

export async function renderParseHealth(data: ReportData): Promise<string> {
  const checks = data.consistencyChecks || {};
  const parseRate = checks.parseSuccessRate?.value ?? (data.summary.parsedFiles / data.summary.totalFiles);
  const scannedRatio = checks.scannedPdfRatio?.value ?? 0;

  const successColor = parseRate >= 0.9 ? '#43a047' : parseRate >= 0.75 ? '#ff6b35' : '#d32f2f';

  return `<section class="parse-health">
    <h2>Parse Health & OCR Status</h2>
    <div class="parse-health-metrics">
      <div class="parse-metric">
        <div class="metric-label">Parse Success Rate</div>
        <div class="metric-gauge">
          <div class="gauge-bar" style="width: ${parseRate * 100}%; background-color: ${successColor};"></div>
        </div>
        <div class="metric-value">${formatPercent(parseRate, 1)}</div>
      </div>
      <div class="parse-metric">
        <div class="metric-label">Scanned PDFs Requiring OCR</div>
        <div class="metric-gauge">
          <div class="gauge-bar" style="width: ${scannedRatio * 100}%; background-color: #ff6b35;"></div>
        </div>
        <div class="metric-value">${formatPercent(scannedRatio, 1)}</div>
      </div>
    </div>

    <div class="parse-summary">
      <h3>Summary</h3>
      <ul>
        <li><strong>${data.summary.parsedFiles}/${data.summary.totalFiles}</strong> files successfully parsed</li>
        <li><strong>${Math.round(scannedRatio * data.summary.totalFiles)}</strong> documents require OCR processing</li>
        <li>Parse success rate: <span style="color: ${successColor}; font-weight: 600;">${formatPercent(parseRate, 1)}</span></li>
      </ul>
    </div>
  </section>`;
}
