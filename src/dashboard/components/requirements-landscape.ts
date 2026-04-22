export interface RequirementEntry {
  type: string;
  category?: string;
  safetyFlag?: boolean;
  count?: number;
}

export interface ReportData {
  requirements?: RequirementEntry[];
}

export async function renderRequirementsLandscape(data: ReportData): Promise<string> {
  const reqs = data.requirements || [];

  // Aggregate by type
  const typeCounts: Record<string, number> = {};
  let safetyFlagged = 0;
  reqs.forEach((r) => {
    const key = r.type || 'UNKNOWN';
    typeCounts[key] = (typeCounts[key] || 0) + (r.count ?? 1);
    if (r.safetyFlag) safetyFlagged += r.count ?? 1;
  });

  // Aggregate by category
  const catCounts: Record<string, number> = {};
  reqs.forEach((r) => {
    const key = r.category || 'Uncategorized';
    catCounts[key] = (catCounts[key] || 0) + (r.count ?? 1);
  });

  const typeLabels = Object.keys(typeCounts);
  const typeData = Object.values(typeCounts);
  const catLabels = Object.keys(catCounts);
  const catData = Object.values(catCounts);
  const total = typeData.reduce((a, b) => a + b, 0);

  const typeColors: Record<string, string> = {
    MUSS: '#d32f2f',
    SOLL: '#ff6b35',
    KANN: '#1e88e5',
    DEKLARATIV: '#43a047',
    INFORMATIV: '#9c27b0',
  };
  const barColors = typeLabels.map((t) => typeColors[t] || '#607d8b');

  const safetyBadge =
    safetyFlagged > 0
      ? `<div class="safety-badge">
          <span class="safety-icon">⚠</span>
          <span class="safety-text">${safetyFlagged} safety-critical requirement${safetyFlagged !== 1 ? 's' : ''} flagged</span>
        </div>`
      : '';

  return `<section class="requirements-landscape">
    <h2>Requirements Landscape</h2>
    ${safetyBadge}
    <div class="req-summary">
      <span class="req-total">${total.toLocaleString()} total requirements</span>
    </div>
    <div class="distribution-grid">
      <div class="chart-container">
        <h3>By Type</h3>
        <canvas id="req-type-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>By Category</h3>
        <canvas id="req-cat-chart"></canvas>
      </div>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;

      const typeCtx = document.getElementById('req-type-chart');
      if (typeCtx) {
        new Chart(typeCtx, {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(typeLabels)},
            datasets: [{
              label: 'Count',
              data: ${JSON.stringify(typeData)},
              backgroundColor: ${JSON.stringify(barColors)},
              borderColor: '#0f1419',
              borderWidth: 1,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true } },
          },
        });
      }

      const catCtx = document.getElementById('req-cat-chart');
      if (catCtx) {
        const catColors = ['#1e88e5','#ff6b35','#43a047','#d32f2f','#9c27b0','#00bcd4','#607d8b'];
        new Chart(catCtx, {
          type: 'doughnut',
          data: {
            labels: ${JSON.stringify(catLabels)},
            datasets: [{
              data: ${JSON.stringify(catData)},
              backgroundColor: catColors.slice(0, ${catLabels.length}),
              borderColor: '#0f1419',
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { position: 'bottom' } },
          },
        });
      }
    });
  </script>`;
}
