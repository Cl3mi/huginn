export interface ReferenceEntry {
  text: string;
  type: string;
  standard?: string;
  status?: string;
}

export interface ReportData {
  references?: ReferenceEntry[];
  consistencyChecks?: Record<string, { value: number; pass?: boolean }>;
}

export async function renderReferenceGraph(data: ReportData): Promise<string> {
  const refs = data.references || [];

  // Count by type
  const typeCounts: Record<string, number> = {};
  refs.forEach((r) => {
    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
  });

  // Count by standard (for norms)
  const normCounts: Record<string, number> = {};
  refs
    .filter((r) => r.type === 'norm' && r.standard)
    .forEach((r) => {
      normCounts[r.standard!] = (normCounts[r.standard!] || 0) + 1;
    });

  // Resolution rate from consistency checks
  const resolutionRate = data.consistencyChecks?.referenceResolutionRate?.value ?? null;
  const resolved = refs.filter((r) => r.status === 'resolved').length;
  const unresolved = refs.filter((r) => r.status === 'unresolved').length;
  const computedRate = refs.length > 0 ? resolved / refs.length : 0;
  const displayRate = resolutionRate ?? computedRate;

  // Top norms (by count)
  const topNormEntries = Object.entries(normCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const normLabels = topNormEntries.map(([k]) => k);
  const normData = topNormEntries.map(([, v]) => v);

  // Unique referenced standards as badges
  const uniqueNorms = refs
    .filter((r) => r.type === 'norm')
    .map((r) => r.text)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 20);

  const normBadges = uniqueNorms
    .map((n) => `<span class="norm-badge">${escapeHtml(n)}</span>`)
    .join('');

  const resColor = displayRate >= 0.85 ? '#43a047' : displayRate >= 0.65 ? '#ff6b35' : '#d32f2f';
  const resPercent = (displayRate * 100).toFixed(1);

  return `<section class="reference-graph">
    <h2>References & Graph Resolution</h2>
    <div class="ref-overview">
      <div class="ref-resolution-gauge">
        <div class="metric-label">Reference Resolution Rate</div>
        <div class="metric-gauge">
          <div class="gauge-bar" style="width:${resPercent}%;background-color:${resColor}"></div>
        </div>
        <div class="metric-value" style="color:${resColor}">${resPercent}%</div>
        <p class="ref-counts">${resolved} resolved &bull; ${unresolved} unresolved &bull; ${refs.length} total</p>
      </div>
      <div class="norm-badges-container">
        <h3>Detected Norms & Standards</h3>
        <div class="norm-badges">${normBadges || '<em>None detected</em>'}</div>
      </div>
    </div>
    ${
      normLabels.length > 0
        ? `<div class="chart-container" style="max-width:640px">
        <h3>By Standard Body</h3>
        <canvas id="norm-chart"></canvas>
      </div>`
        : ''
    }
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;
      const normCtx = document.getElementById('norm-chart');
      if (normCtx) {
        new Chart(normCtx, {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(normLabels)},
            datasets: [{
              label: 'References',
              data: ${JSON.stringify(normData)},
              backgroundColor: '#1e88e5',
              borderColor: '#0f1419',
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } },
          },
        });
      }
    });
  </script>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, (m) => map[m] ?? m);
}
