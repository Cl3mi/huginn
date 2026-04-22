export interface ConsistencyCheck {
  value: number;
  threshold?: number;
  pass?: boolean;
}

export interface ReportData {
  consistencyChecks?: Record<string, ConsistencyCheck>;
}

const CHECK_LABELS: Record<string, { label: string; description: string; unit: string }> = {
  parseSuccessRate: {
    label: 'Parse Success Rate',
    description: 'Share of documents successfully parsed.',
    unit: '%',
  },
  scannedPdfRatio: {
    label: 'Scanned PDF Ratio',
    description: 'Share of PDFs requiring OCR (higher = less native text).',
    unit: '%',
  },
  requirementDensity: {
    label: 'Requirement Density',
    description: 'Average requirements per parsed document.',
    unit: '/doc',
  },
  referenceResolutionRate: {
    label: 'Reference Resolution Rate',
    description: 'Share of references successfully resolved within corpus.',
    unit: '%',
  },
  versionPairRatio: {
    label: 'Version Pair Ratio',
    description: 'Share of document pairs that are HIGH-confidence version matches.',
    unit: '%',
  },
};

export async function renderRagDecisions(data: ReportData): Promise<string> {
  const checks = data.consistencyChecks || {};

  const rows = Object.entries(checks)
    .map(([key, check]) => {
      const meta = CHECK_LABELS[key] || { label: key, description: '', unit: '' };
      const isPercent = meta.unit === '%';
      const displayValue = isPercent
        ? `${(check.value * 100).toFixed(1)}%`
        : `${check.value.toFixed(2)}${meta.unit}`;
      const threshold =
        check.threshold !== undefined
          ? isPercent
            ? `${(check.threshold * 100).toFixed(0)}%`
            : `${check.threshold.toFixed(2)}${meta.unit}`
          : '—';
      const pass = check.pass ?? (check.threshold !== undefined ? check.value >= check.threshold : null);
      const statusHtml =
        pass === null
          ? '<span class="badge info">—</span>'
          : pass
            ? '<span class="badge success">PASS</span>'
            : '<span class="badge danger">FAIL</span>';

      return `<tr>
        <td>
          <strong>${meta.label}</strong>
          ${meta.description ? `<br><span class="check-desc">${meta.description}</span>` : ''}
        </td>
        <td style="font-family:monospace;text-align:right">${displayValue}</td>
        <td style="text-align:right;color:#a0a4ab">${threshold}</td>
        <td style="text-align:center">${statusHtml}</td>
      </tr>`;
    })
    .join('');

  const totalChecks = Object.keys(checks).length;
  const passed = Object.values(checks).filter((c) => c.pass === true).length;
  const failed = Object.values(checks).filter((c) => c.pass === false).length;

  const summaryColor = failed === 0 ? '#43a047' : failed <= 1 ? '#ff6b35' : '#d32f2f';
  const summaryText = failed === 0 ? 'All checks passing' : `${failed} check${failed !== 1 ? 's' : ''} failing`;

  return `<section class="rag-decisions">
    <h2>RAG Architecture Recommendations</h2>
    <div class="consistency-summary" style="border-left-color:${summaryColor}">
      <span class="summary-icon" style="color:${summaryColor}">${failed === 0 ? '✓' : '⚠'}</span>
      <span class="summary-text">${summaryText} &bull; ${passed}/${totalChecks} consistency checks passed</span>
    </div>
    ${
      rows
        ? `<div class="table-search-wrap">
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
      </table>`
        : '<p class="placeholder">No consistency checks in report.</p>'
    }
  </section>`;
}
