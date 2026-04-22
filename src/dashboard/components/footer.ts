export interface ReportData {
  scanId: string;
  timestamp: string;
}

export async function renderFooter(data: ReportData): Promise<string> {
  const now = new Date().toISOString().split('T')[0];

  return `<footer class="dashboard-footer">
    <div class="footer-content">
      <div class="footer-left">
        <p class="footer-credit">Huginn Document Intelligence</p>
        <p class="footer-scan-id">Scan ID: <code>${escapeHtml(data.scanId)}</code></p>
      </div>
      <div class="footer-right">
        <p class="footer-generated">Generated on ${now}</p>
        <p class="footer-note">All data is embedded — offline access guaranteed</p>
      </div>
    </div>
    <div class="footer-actions">
      <button class="btn btn-secondary" onclick="window.print()">📄 Print</button>
      <button class="btn btn-secondary" onclick="downloadJson()">⬇️ Download JSON</button>
    </div>
  </footer>

  <script>
    function downloadJson() {
      const reportData = JSON.parse(document.getElementById('report-data').textContent);
      const json = JSON.stringify(reportData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scan-report.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  </script>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m] ?? m);
}
