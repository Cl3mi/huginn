import type { ReportData } from '../lib/report-types.js';

export async function renderParseHealth(data: ReportData): Promise<string> {
  const s = data.summary;
  const parseRate = s.totalFiles > 0 ? s.parsedFiles / s.totalFiles : 0;
  const ocrRatio = s.totalFiles > 0 ? s.ocrRequired / s.totalFiles : 0;
  const scannedRatio = s.totalFiles > 0 ? s.scannedPdfs / s.totalFiles : 0;

  const parseColor = parseRate >= 0.9 ? '#43a047' : parseRate >= 0.75 ? '#ff6b35' : '#d32f2f';
  const failedFiles = data.parseHealth.failedFiles;

  const failRows = failedFiles
    .slice(0, 10)
    .map(
      (f) => `<tr>
        <td><a class="doc-link" href="#" data-path="${ea(f.path)}" title="${ea(f.path)}">${esc(shortName(f.path))}</a></td>
        <td style="color:#d32f2f;font-size:.85em">${esc(f.reason)}</td>
      </tr>`,
    )
    .join('');

  return `<section class="parse-health">
    <h2>Parse Health & OCR Status</h2>
    <p class="section-desc">${s.parsedFiles} parsed &bull; ${s.parseFailures} failed &bull; ${s.scannedPdfs} scanned PDFs &bull; ${s.ocrRequired} need OCR</p>
    <div class="parse-health-metrics">
      <div class="parse-metric">
        <div class="metric-label">Parse Success Rate</div>
        <div class="metric-gauge"><div class="gauge-bar" style="width:${(parseRate * 100).toFixed(1)}%;background:${parseColor}"></div></div>
        <div class="metric-value" style="color:${parseColor}">${(parseRate * 100).toFixed(1)}%</div>
      </div>
      <div class="parse-metric">
        <div class="metric-label">OCR Required</div>
        <div class="metric-gauge"><div class="gauge-bar" style="width:${(ocrRatio * 100).toFixed(1)}%;background:#ff9800"></div></div>
        <div class="metric-value" style="color:#ff9800">${s.ocrRequired}<span style="font-size:.75em;font-weight:400;margin-left:.3em">/ ${s.totalFiles} files</span></div>
      </div>
      <div class="parse-metric">
        <div class="metric-label">Scanned PDFs</div>
        <div class="metric-gauge"><div class="gauge-bar" style="width:${(scannedRatio * 100).toFixed(1)}%;background:#607d8b"></div></div>
        <div class="metric-value" style="color:#607d8b">${s.scannedPdfs}<span style="font-size:.75em;font-weight:400;margin-left:.3em">of ${s.totalFiles}</span></div>
      </div>
    </div>
    ${
      failedFiles.length > 0
        ? `<div class="failed-files-block">
        <h3>Parse Failures${failedFiles.length > 10 ? ` (top 10 of ${failedFiles.length})` : ''}</h3>
        <table>
          <thead><tr><th>File</th><th>Reason</th></tr></thead>
          <tbody>${failRows}</tbody>
        </table>
      </div>`
        : '<p class="empty-state" style="margin-top:1rem">All files parsed successfully.</p>'
    }
  </section>`;
}

function shortName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.length > 40 ? base.slice(0, 37) + '…' : base;
}

function ea(s: string) { return s.replace(/"/g, '&quot;'); }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] ?? m));
}
