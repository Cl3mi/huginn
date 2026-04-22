import { formatDate, formatPercent } from '../lib/formatters.js';
import { COLORS } from '../lib/chart-config.js';

export interface ReportData {
  scanId: string;
  timestamp: string;
  summary: {
    totalFiles: number;
    parsedFiles: number;
    versionPairs: number;
    references: number;
    requirements: number;
    mqScore?: number;
  };
  parsed?: Array<{ filename: string; language?: string; pageCount?: number }>;
  versionPairs?: Array<{ score: number; docA: string; docB: string }>;
  references?: Array<{ text: string; type: string }>;
  requirements?: Array<{ type: string; category?: string; safetyFlag?: boolean }>;
  consistencyChecks?: Record<string, { value: number; threshold?: number; pass?: boolean }>;
}

export async function renderHeader(data: ReportData): Promise<string> {
  const mqScore = data.summary.mqScore ?? 0;
  const mqColor = getMqColor(mqScore);
  const formattedDate = formatDate(data.timestamp);
  const parseRate = data.summary.totalFiles > 0 ? data.summary.parsedFiles / data.summary.totalFiles : 0;

  return `<header class="dashboard-header">
    <div class="header-content">
      <h1>${escapeHtml(data.scanId)}</h1>
      <p class="timestamp">${formattedDate}</p>
    </div>
    <div class="header-metrics">
      <div class="mq-badge" style="background-color: ${mqColor}">
        <span class="mq-label">MQ Score</span>
        <span class="mq-value">${mqScore}</span>
      </div>
      <div class="parse-badge">
        <span class="parse-label">Parse Rate</span>
        <span class="parse-value">${formatPercent(parseRate, 1)}</span>
      </div>
    </div>
  </header>`;
}

function getMqColor(score: number): string {
  if (score < 33) return COLORS.accent.red;
  if (score < 66) return COLORS.accent.orange;
  return COLORS.accent.green;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}
