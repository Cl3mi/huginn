import type { ReportData } from '../lib/report-types.js';

const CHECK_DISPLAY: Record<string, { label: string; unit: string }> = {
  parseSuccessRate:        { label: 'Parse Success Rate',     unit: '%' },
  scannedPdfRatio:         { label: 'Scanned PDF Ratio',      unit: '%' },
  requirementDensity:      { label: 'Requirement Density',    unit: '/doc' },
  referenceResolutionRate: { label: 'Ref. Resolution Rate',   unit: '%' },
  versionPairRatio:        { label: 'Version Pair Ratio',     unit: '%' },
};

const SEVERITY_COLOR: Record<string, string> = {
  INFO: '#1e88e5', WARNING: '#ff6b35', CRITICAL: '#d32f2f',
};

export async function renderRagDecisions(data: ReportData): Promise<string> {
  const checks = data.consistencyChecks;

  if (checks.length === 0) {
    return `<section class="rag-decisions">
      <h2>Consistency Checks</h2>
      <p class="empty-state">No consistency checks in report.</p>
    </section>`;
  }

  const failed = checks.filter((c) => !c.passed);
  const passedCount = checks.length - failed.length;
  const hasCritical = failed.some((c) => c.severity === 'CRITICAL');
  const summaryColor = hasCritical ? '#d32f2f' : failed.length > 0 ? '#ff6b35' : '#43a047';
  const summaryText =
    failed.length === 0
      ? `All ${checks.length} checks passing`
      : `${failed.length} check${failed.length !== 1 ? 's' : ''} failing — ${passedCount}/${checks.length} passed`;

  const sorted = [...checks].sort((a, b) => {
    const sev = { CRITICAL: 0, WARNING: 1, INFO: 2 };
    const diff = (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3);
    if (diff !== 0) return diff;
    return a.passed === b.passed ? 0 : a.passed ? 1 : -1;
  });

  const rows = sorted
    .map((c) => {
      const meta = CHECK_DISPLAY[c.checkName];
      const isPercent = meta?.unit === '%';
      const isPerDoc = meta?.unit === '/doc';
      const displayValue = isPercent
        ? `${(c.value * 100).toFixed(1)}%`
        : isPerDoc
          ? `${c.value.toFixed(2)}/doc`
          : `${c.value.toFixed(2)}`;
      const threshDisplay = isPercent
        ? `${(c.threshold * 100).toFixed(0)}%`
        : `${c.threshold.toFixed(2)}`;
      const sevColor = SEVERITY_COLOR[c.severity] ?? '#607d8b';
      const passHtml = c.passed
        ? `<span class="badge success">PASS</span>`
        : `<span class="badge" style="background:${sevColor};color:#fff">${c.severity}</span>`;
      return `<tr>
        <td><strong>${esc(meta?.label ?? c.checkName)}</strong><br><span class="check-desc">${esc(c.interpretation)}</span></td>
        <td style="font-family:monospace;text-align:right;white-space:nowrap">${displayValue}</td>
        <td style="text-align:right;color:#a0a4ab">${threshDisplay}</td>
        <td style="text-align:center">${passHtml}</td>
      </tr>`;
    })
    .join('');

  return `<section class="rag-decisions">
    <h2>Consistency Checks</h2>
    <div class="consistency-summary" style="border-left-color:${summaryColor}">
      <span style="color:${summaryColor}">${failed.length === 0 ? '✓' : '⚠'}</span>
      <span class="summary-text">${summaryText}</span>
    </div>
    <div class="table-search-wrap">
      <input class="table-search" type="search" placeholder="Filter checks…" data-table="consistency-table-data">
      <span class="table-search-count"></span>
    </div>
    <table id="consistency-table-data" class="consistency-table">
      <thead>
        <tr>
          <th>Check</th>
          <th style="text-align:right">Value</th>
          <th style="text-align:right">Threshold</th>
          <th style="text-align:center">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] ?? m));
}
