import type { ReportData } from '../lib/report-types.js';
import { isNormRef, isResolved, displayNormText } from '../lib/report-types.js';

export async function renderReferenceGraph(data: ReportData): Promise<string> {
  const refs = data.references;

  if (refs.length === 0) {
    return `<section class="reference-graph">
      <h2>References & Graph Resolution</h2>
      <p class="empty-state">No references extracted from this corpus.</p>
    </section>`;
  }

  const normRefs = refs.filter((r) => isNormRef(r.type));
  const internalRefs = refs.filter((r) => ['doc_ref','chapter_ref','fikb','kb_master'].includes(r.type));
  const resolved = refs.filter((r) => isResolved(r.resolutionMethod)).length;
  const unresolved = refs.filter((r) => r.resolutionMethod === 'unresolved').length;
  const externalNorm = refs.filter((r) => r.resolutionMethod === 'external_norm').length;

  const resRate = refs.length > 0 ? (resolved + externalNorm) / refs.length : 0;
  const resColor = resRate >= 0.85 ? '#43a047' : resRate >= 0.65 ? '#ff6b35' : '#d32f2f';

  // Count by standard family for norm refs
  const TYPE_LABELS: Record<string, string> = {
    iso_norm: 'ISO', din_norm: 'DIN', en_norm: 'EN', vda_norm: 'VDA', iatf_norm: 'IATF',
  };
  const normFamilyCounts: Record<string, number> = {};
  normRefs.forEach((r) => {
    const label = TYPE_LABELS[r.type] ?? r.type;
    normFamilyCounts[label] = (normFamilyCounts[label] ?? 0) + 1;
  });
  const famEntries = Object.entries(normFamilyCounts).sort((a, b) => b[1] - a[1]);

  // Unique norm display texts (up to 24)
  const uniqueNorms = [...new Map(normRefs.map((r) => [r.rawText, displayNormText(r)])).values()].slice(0, 24);

  // Missing-from-corpus refs
  const missingRefs = refs
    .filter((r) => r.resolutionClassification === 'likely_missing_from_corpus')
    .map((r) => displayNormText(r))
    .slice(0, 8);

  const normBadges = uniqueNorms.map((n) => `<span class="norm-badge">${esc(n)}</span>`).join('');

  return `<section class="reference-graph">
    <h2>References & Graph Resolution</h2>
    <p class="section-desc">${refs.length} total &bull; ${normRefs.length} norms &bull; ${internalRefs.length} internal &bull; ${resolved} resolved &bull; ${externalNorm} external norms</p>

    <div class="ref-overview-grid">
      <div class="ref-resolution-block">
        <div class="metric-label">Resolution Rate</div>
        <div class="metric-gauge"><div class="gauge-bar" style="width:${(resRate*100).toFixed(1)}%;background:${resColor}"></div></div>
        <div class="metric-value" style="color:${resColor}">${(resRate*100).toFixed(1)}%</div>
        <div class="ref-breakdown">
          <span class="rb-item rb-ok">✓ ${resolved} exact/fuzzy</span>
          <span class="rb-item rb-ext">⊞ ${externalNorm} external norm</span>
          <span class="rb-item rb-miss">✗ ${unresolved} unresolved</span>
        </div>
      </div>

      <div class="norm-badges-block">
        <div class="metric-label" style="margin-bottom:.75rem">Detected Norms & Standards</div>
        <div class="norm-badges">${normBadges || '<em style="color:#607d8b">None detected</em>'}</div>
      </div>
    </div>

    ${famEntries.length > 0 ? `<div class="chart-container" style="max-width:480px;margin-top:1.5rem">
      <h3>By Standard Body</h3>
      <canvas id="norm-family-chart"></canvas>
    </div>` : ''}

    ${missingRefs.length > 0 ? `<div class="missing-refs-block">
      <div class="metric-label" style="margin-bottom:.5rem">⚠ Likely Missing from Corpus</div>
      ${missingRefs.map((r) => `<span class="norm-badge norm-badge-warn">${esc(r)}</span>`).join(' ')}
    </div>` : ''}
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;
      const famCtx = document.getElementById('norm-family-chart');
      if (famCtx) {
        new Chart(famCtx, {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(famEntries.map(([k]) => k))},
            datasets: [{ data: ${JSON.stringify(famEntries.map(([,v]) => v))}, backgroundColor: '#1e88e5', borderWidth: 0 }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { grid: { display: false } } },
          },
        });
      }
    });
  </script>`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[m] ?? m));
}
