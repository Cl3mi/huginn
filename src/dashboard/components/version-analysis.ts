export interface VersionPair {
  score: number;
  docA: string;
  docB: string;
  confidence?: number;
}

export interface ReportData {
  versionPairs?: VersionPair[];
}

export async function renderVersionAnalysis(data: ReportData): Promise<string> {
  const pairs = data.versionPairs || [];
  const highPairs = pairs.filter((p) => p.score >= 7);

  // Build score histogram buckets
  const buckets = [
    { label: '10-12', min: 10, max: 12, color: '#43a047' },
    { label: '7-9', min: 7, max: 9, color: '#8bc34a' },
    { label: '5-6', min: 5, max: 6, color: '#ff6b35' },
    { label: '3-4', min: 3, max: 4, color: '#ff9800' },
    { label: '0-2', min: 0, max: 2, color: '#607d8b' },
  ];
  const bucketCounts = buckets.map((b) => pairs.filter((p) => p.score >= b.min && p.score <= b.max).length);

  // Build adjacency for a simple chain visualization using SVG
  const chainSvg = buildVersionChainSvg(highPairs);

  // Table rows for HIGH pairs
  const pairRows = highPairs
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(
      (p) => `
    <tr>
      <td><span class="score-badge score-${getScoreClass(p.score)}">${p.score}</span></td>
      <td class="doc-name" title="${escapeAttr(p.docA)}">${shortName(p.docA)}</td>
      <td class="doc-name" title="${escapeAttr(p.docB)}">${shortName(p.docB)}</td>
      ${p.confidence !== undefined ? `<td>${(p.confidence * 100).toFixed(0)}%</td>` : '<td>—</td>'}
    </tr>
  `,
    )
    .join('');

  return `<section class="version-analysis">
    <h2>Version Pairs & Clustering</h2>
    <div class="version-summary">
      <span class="version-count">${pairs.length} total pairs &bull; ${highPairs.length} HIGH confidence (≥7)</span>
    </div>
    <div class="distribution-grid">
      <div class="chart-container">
        <h3>Score Distribution</h3>
        <canvas id="version-score-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Version Chains (HIGH ≥ 7)</h3>
        <div class="chain-viz">${chainSvg}</div>
      </div>
    </div>
    <div class="pairs-table">
      <h3>HIGH Confidence Pairs</h3>
      <div class="table-search-wrap">
        <input class="table-search" type="search" placeholder="Filter pairs…" data-table="pairs-table-data">
        <span class="table-search-count"></span>
      </div>
      <table id="pairs-table-data">
        <thead>
          <tr>
            <th>Score</th>
            <th>Document A</th>
            <th>Document B</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>${pairRows}</tbody>
      </table>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;

      const versionCtx = document.getElementById('version-score-chart');
      if (versionCtx) {
        new Chart(versionCtx, {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(buckets.map((b) => b.label))},
            datasets: [{
              label: 'Pairs',
              data: ${JSON.stringify(bucketCounts)},
              backgroundColor: ${JSON.stringify(buckets.map((b) => b.color))},
              borderColor: '#0f1419',
              borderWidth: 1,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
          },
        });
      }
    });
  </script>`;
}

function buildVersionChainSvg(pairs: VersionPair[]): string {
  if (pairs.length === 0) return '<p class="no-data">No HIGH confidence pairs detected.</p>';

  // Build adjacency: each node is a unique filename
  const nodeSet = new Set<string>();
  pairs.forEach((p) => { nodeSet.add(p.docA); nodeSet.add(p.docB); });
  const nodes = Array.from(nodeSet);

  // BFS to find connected components (version chains)
  const adj: Map<string, string[]> = new Map();
  nodes.forEach((n) => adj.set(n, []));
  pairs.forEach((p) => {
    adj.get(p.docA)!.push(p.docB);
    adj.get(p.docB)!.push(p.docA);
  });

  const visited = new Set<string>();
  const chains: string[][] = [];
  nodes.forEach((start) => {
    if (visited.has(start)) return;
    const chain: string[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      chain.push(cur);
      adj.get(cur)!.forEach((n) => { if (!visited.has(n)) queue.push(n); });
    }
    chains.push(chain);
  });

  // Render chains as horizontal node rows with connecting lines
  const rowHeight = 44;
  const colWidth = 180;
  const nodeW = 160;
  const nodeH = 28;
  const svgHeight = chains.length * rowHeight + 20;
  const svgWidth = Math.max(...chains.map((c) => c.length)) * colWidth + 20;

  let circles = '';
  let lines = '';

  chains.forEach((chain, row) => {
    const y = row * rowHeight + 30;
    chain.forEach((name, col) => {
      const x = col * colWidth + 10;
      circles += `<rect x="${x}" y="${y - nodeH / 2}" width="${nodeW}" height="${nodeH}"
        rx="3" fill="#1a1f26" stroke="#ff6b35" stroke-width="1"/>
      <text x="${x + nodeW / 2}" y="${y + 5}" text-anchor="middle"
        font-family="monospace" font-size="10" fill="#e4e6eb" clip-path="url(#clip-${row}-${col})">
        ${escapeXml(shortName(name))}
      </text>`;
      if (col > 0) {
        const prevX = (col - 1) * colWidth + nodeW + 10;
        lines += `<line x1="${prevX}" y1="${y}" x2="${x}" y2="${y}"
          stroke="#2a3038" stroke-width="1" marker-end="url(#arrow)"/>`;
      }
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}"
    style="width:100%;max-height:240px;overflow:auto">
    <defs>
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L0,6 L6,3 z" fill="#2a3038"/>
      </marker>
    </defs>
    ${lines}
    ${circles}
  </svg>`;
}

function getScoreClass(score: number): string {
  if (score >= 10) return 'high';
  if (score >= 7) return 'medium';
  return 'low';
}

function shortName(path: string): string {
  const base = path.split('/').pop() || path;
  return base.length > 22 ? base.substring(0, 19) + '...' : base;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
