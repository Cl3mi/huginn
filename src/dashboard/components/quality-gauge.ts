import { formatPercent } from '../lib/formatters.js';

export interface ReportData {
  summary: { mqScore?: number };
  parsed?: Array<{ filename: string }>;
  consistencyChecks?: Record<string, { value: number; pass?: boolean }>;
}

export async function renderQualityGauge(data: ReportData): Promise<string> {
  const mqScore = data.summary.mqScore ?? 0;

  // Component breakdown from consistency checks
  const checks = data.consistencyChecks || {};
  const parseRate = checks.parseSuccessRate?.value ?? 0;
  const scannedRatio = checks.scannedPdfRatio?.value ?? 0;
  const refResolution = checks.referenceResolutionRate?.value ?? 0;

  const components = [
    { label: 'Parse Success', value: parseRate, color: '#1e88e5' },
    { label: 'Scanned PDF', value: scannedRatio, color: '#ff6b35' },
    { label: 'Ref Resolution', value: refResolution, color: '#43a047' },
  ];

  const componentRows = components
    .map(
      (comp) => `
    <tr>
      <td>${comp.label}</td>
      <td><span class="color-swatch" style="background-color: ${comp.color}"></span></td>
      <td style="text-align: right"><strong>${formatPercent(comp.value, 1)}</strong></td>
    </tr>
  `,
    )
    .join('');

  return `<section class="quality-gauge">
    <h2>Data Quality Assessment</h2>
    <div class="gauge-container">
      <div class="gauge-chart">
        <canvas id="quality-chart" style="max-width: 300px; margin: 0 auto;"></canvas>
        <div class="gauge-center">
          <div class="gauge-score">${mqScore}</div>
          <div class="gauge-label">MQ Score</div>
        </div>
      </div>
      <div class="gauge-components">
        <h3>Component Breakdown</h3>
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th></th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            ${componentRows}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') {
        console.warn('Chart.js not loaded, skipping quality gauge');
        return;
      }
      const ctx = document.getElementById('quality-chart');
      if (ctx) {
        new Chart(ctx, {
          type: 'doughnut',
          data: {
            datasets: [{
              data: [${mqScore}, ${100 - mqScore}],
              backgroundColor: ['#43a047', '#2a3038'],
              borderColor: '#0f1419',
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
              tooltip: { enabled: false },
            },
          },
        });
      }
    });
  </script>`;
}
