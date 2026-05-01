import type { ReportData } from '../lib/report-types.js';

export async function renderFooter(data: ReportData): Promise<string> {
  const generated = new Date().toISOString().split('T')[0];

  return `<footer class="dashboard-footer">
    <div class="footer-content">
      <div class="footer-left">
        <p class="footer-credit">Huginn Document Intelligence</p>
        <p class="footer-scan-id">Scan: <code>${esc(data.scanId)}</code></p>
      </div>
      <div class="footer-right">
        <p>Generated ${generated}</p>
        <p style="margin-top:.25rem;font-size:.8em">All data embedded — offline access guaranteed</p>
      </div>
    </div>
    <div class="footer-actions">
      <button class="btn btn-secondary" onclick="window.print()">Print</button>
      <button class="btn btn-secondary" onclick="downloadJson()">Download JSON</button>
    </div>
  </footer>

  <script>
    function downloadJson() {
      const el = document.getElementById('report-data');
      if (!el) return;
      const blob = new Blob([el.textContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'scan-report.json'; a.click();
      URL.revokeObjectURL(url);
    }
  </script>`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] ?? m));
}
