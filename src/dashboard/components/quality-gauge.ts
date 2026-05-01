import type { ReportData } from '../lib/report-types.js';

export async function renderQualityGauge(data: ReportData): Promise<string> {
  const mq = data.metadataQualityScore;
  const score = mq.overall;
  const gaugeColor = score >= 80 ? '#43a047' : score >= 60 ? '#ff6b35' : '#d32f2f';
  const c = mq.components;

  const rows: Array<{ label: string; raw: number | string | undefined; unit: string; color: string }> = [
    { label: 'Parse Success Rate', raw: c['parseSuccessRate'], unit: '%', color: '#1e88e5' },
    { label: 'Heading Extraction', raw: c['headingExtractionConfidence'], unit: '%', color: '#43a047' },
    { label: 'Req. Validation Agreement', raw: c['requirementValidationDelta'], unit: '%', color: '#ff6b35' },
    { label: 'OCR Coverage', raw: c['ocrWarningRate'] !== undefined ? 100 - Number(c['ocrWarningRate']) : undefined, unit: '%', color: '#9c27b0' },
  ];

  const tableRows = rows
    .map((r) => {
      const display = r.raw !== undefined ? `${Number(r.raw).toFixed(1)}${r.unit}` : '—';
      const barW = r.raw !== undefined ? Math.min(100, Math.max(0, Number(r.raw))) : 0;
      return `<tr>
        <td>${r.label}</td>
        <td>
          <div class="mini-bar-wrap">
            <div class="mini-bar" style="width:${barW}%;background:${r.color}"></div>
          </div>
        </td>
        <td style="text-align:right;font-family:monospace;font-weight:600">${display}</td>
      </tr>`;
    })
    .join('');

  const calibrationNote =
    c['versionPairCalibrationStatus']
      ? `<p class="calibration-note">Version calibration: ${String(c['versionPairCalibrationStatus'])}</p>`
      : '';

  return `<section class="quality-gauge">
    <h2>Data Quality Assessment</h2>
    <p class="section-desc">${escapeHtml(mq.interpretation)}</p>
    <div class="gauge-container">
      <div class="gauge-chart-wrap">
        <canvas id="mq-gauge-chart" width="220" height="220"></canvas>
        <div class="gauge-center-text">
          <div class="gauge-score" style="color:${gaugeColor}">${score}</div>
          <div class="gauge-sub">/100</div>
        </div>
      </div>
      <div class="gauge-components">
        <table class="component-table">
          <thead><tr><th>Component</th><th style="width:120px"></th><th>Score</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        ${calibrationNote}
      </div>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;
      const ctx = document.getElementById('mq-gauge-chart');
      if (ctx) {
        new Chart(ctx, {
          type: 'doughnut',
          data: {
            datasets: [{ data: [${score}, ${100 - score}], backgroundColor: ['${gaugeColor}','#1e2530'], borderWidth: 0 }],
          },
          options: {
            cutout: '78%',
            rotation: -90,
            circumference: 180,
            responsive: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
          },
        });
      }
    });
  </script>`;
}

function escapeHtml(t: string) {
  return t.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c] ?? c));
}
