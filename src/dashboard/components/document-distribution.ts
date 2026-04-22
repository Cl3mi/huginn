export interface ReportData {
  parsed?: Array<{ filename: string; language?: string; pageCount?: number }>;
}

export async function renderDocumentDistribution(data: ReportData): Promise<string> {
  const docs = data.parsed || [];

  // Extract file extensions
  const extensionCounts: Record<string, number> = {};
  docs.forEach((doc) => {
    const ext = doc.filename.split('.').pop()?.toLowerCase() || 'unknown';
    extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
  });

  // Count languages
  const languageCounts: Record<string, number> = {};
  docs.forEach((doc) => {
    const lang = doc.language || 'unknown';
    languageCounts[lang] = (languageCounts[lang] || 0) + 1;
  });

  const extLabels = Object.keys(extensionCounts).map((k) => k.toUpperCase());
  const extData = Object.values(extensionCounts);
  const langLabels = Object.keys(languageCounts);
  const langData = Object.values(languageCounts);

  return `<section class="document-distribution">
    <h2>Document Distribution & Metadata</h2>
    <div class="distribution-grid">
      <div class="chart-container">
        <h3>By File Extension</h3>
        <canvas id="extension-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>By Language</h3>
        <canvas id="language-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Page Count Distribution</h3>
        <canvas id="pages-chart"></canvas>
      </div>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') {
        console.warn('Chart.js not loaded, skipping distribution charts');
        return;
      }

      // Extension chart (bar)
      const extCtx = document.getElementById('extension-chart');
      if (extCtx) {
        new Chart(extCtx, {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(extLabels)},
            datasets: [{
              label: 'Count',
              data: ${JSON.stringify(extData)},
              backgroundColor: '#ff6b35',
              borderColor: '#0f1419',
              borderWidth: 1,
            }],
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
            },
            scales: {
              y: { beginAtZero: true, max: Math.max(...${JSON.stringify(extData)}, 1) + 1 },
            },
          },
        });
      }

      // Language chart (doughnut)
      const langCtx = document.getElementById('language-chart');
      if (langCtx) {
        const langColors = ['#1e88e5', '#ff6b35', '#43a047', '#d32f2f', '#9c27b0', '#00bcd4'];
        new Chart(langCtx, {
          type: 'doughnut',
          data: {
            labels: ${JSON.stringify(langLabels.map((l) => l.toUpperCase()))},
            datasets: [{
              data: ${JSON.stringify(langData)},
              backgroundColor: langColors.slice(0, ${JSON.stringify(langData).length}),
              borderColor: '#0f1419',
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            plugins: {
              legend: { position: 'bottom' },
            },
          },
        });
      }

      // Page count distribution (histogram)
      const pageCounts = ${JSON.stringify((data.parsed || []).map((d) => d.pageCount || 0))};
      const pageCtx = document.getElementById('pages-chart');
      if (pageCtx && pageCounts.length > 0) {
        const buckets = [0, 10, 20, 50, 100, 200];
        const bucketCounts = Array(buckets.length - 1).fill(0);
        pageCounts.forEach((count) => {
          for (let i = 0; i < buckets.length - 1; i++) {
            if (count >= buckets[i] && count < buckets[i + 1]) {
              bucketCounts[i]++;
              break;
            }
            if (i === buckets.length - 2 && count >= buckets[i + 1]) {
              bucketCounts[i]++;
            }
          }
        });

        new Chart(pageCtx, {
          type: 'bar',
          data: {
            labels: ['0-10', '10-20', '20-50', '50-100', '100-200', '200+'].slice(0, bucketCounts.length),
            datasets: [{
              label: 'Documents',
              data: bucketCounts,
              backgroundColor: '#43a047',
              borderColor: '#0f1419',
              borderWidth: 1,
            }],
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
            },
            scales: {
              y: { beginAtZero: true },
            },
          },
        });
      }
    });
  </script>`;
}
