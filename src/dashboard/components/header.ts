import { formatDate } from '../lib/formatters.js';
import { COLORS } from '../lib/chart-config.js';
import type { ReportData } from '../lib/report-types.js';

export async function renderHeader(data: ReportData): Promise<string> {
  const mqScore = data.metadataQualityScore.overall;
  const mqColor = mqScore >= 80 ? COLORS.accent.green : mqScore >= 60 ? COLORS.accent.orange : COLORS.accent.red;
  const mqInterp = data.metadataQualityScore.interpretation;
  const formattedDate = formatDate(data.startedAt);
  const parseRate = data.summary.totalFiles > 0 ? data.summary.parsedFiles / data.summary.totalFiles : 0;
  const parseRateDisplay = `${(parseRate * 100).toFixed(1)}%`;

  const highPairs = data.versionPairs.filter((p) => p.confidence === 'HIGH').length;

  return `<header class="dashboard-header">
    <div class="header-content">
      <div class="header-logo">HUGINN</div>
      <h1 class="header-scan-id">${escapeHtml(data.scanId)}</h1>
      <p class="timestamp">${formattedDate} &bull; ${escapeHtml(data.documentsRoot ?? '')}</p>
    </div>
    <div class="header-metrics">
      <div class="header-metric">
        <span class="hm-label">MQ Score</span>
        <span class="hm-value" style="color:${mqColor}">${mqScore}<span class="hm-unit">/100</span></span>
        <span class="hm-sub">${escapeHtml(mqInterp)}</span>
      </div>
      <div class="header-metric">
        <span class="hm-label">Parse Rate</span>
        <span class="hm-value" style="color:${parseRate >= 0.9 ? COLORS.accent.green : COLORS.accent.orange}">${parseRateDisplay}</span>
        <span class="hm-sub">${data.summary.parsedFiles}/${data.summary.totalFiles} files</span>
      </div>
      <div class="header-metric">
        <span class="hm-label">HIGH Pairs</span>
        <span class="hm-value" style="color:${COLORS.accent.blue}">${highPairs}</span>
        <span class="hm-sub">version clusters</span>
      </div>
    </div>
  </header>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, (m) => map[m] ?? m);
}
