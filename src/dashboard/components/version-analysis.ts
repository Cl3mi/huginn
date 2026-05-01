import type { ReportData } from '../lib/report-types.js';

export async function renderVersionAnalysis(data: ReportData): Promise<string> {
  const pairs = data.versionPairs;
  const chains = data.versionChains ?? [];

  const highPairs  = pairs.filter((p) => p.confidence === 'HIGH');
  const medPairs   = pairs.filter((p) => p.confidence === 'MEDIUM');

  // Score histogram from pre-computed JSON
  const histogram = data.versionPairScoreHistogram;
  const buckets = [
    { label: '10–12', color: '#43a047' },
    { label: '7–9',   color: '#8bc34a' },
    { label: '5–6',   color: '#ff9800' },
    { label: '3–4',   color: '#ff6b35' },
    { label: '0–2',   color: '#607d8b' },
  ];
  const bucketData = [
    [10, 11, 12], [7, 8, 9], [5, 6], [3, 4], [0, 1, 2],
  ].map((scores) => scores.reduce((sum, s) => sum + (histogram[String(s)] ?? 0), 0));

  // Lookups for doc metadata
  const fileMap   = new Map((data.files   ?? []).map((f) => [f.id, f]));
  const parsedMap = new Map((data.parsed  ?? []).map((p) => [p.id, p]));

  function docMeta(docId: string) {
    const f = fileMap.get(docId);
    const p = f ? parsedMap.get(f.id) : undefined;
    return {
      ext:  f?.extension ?? '',
      type: p?.detectedDocType ?? '',
      id:   f?.id ?? docId,
    };
  }

  // Show HIGH + MEDIUM pairs, top 300 by score
  const shownPairs = [...highPairs, ...medPairs]
    .sort((a, b) => b.score - a.score)
    .slice(0, 300);

  const highCount = shownPairs.filter((p) => p.confidence === 'HIGH').length;
  const medCount  = shownPairs.filter((p) => p.confidence === 'MEDIUM').length;

  const pairRows = shownPairs
    .map((p) => {
      const confColor = p.confidence === 'HIGH' ? '#43a047' : p.confidence === 'MEDIUM' ? '#ff9800' : '#607d8b';
      const flagNote  = p.versionPairFlag === 'template_reuse_suspected'
        ? ' <span class="flag-badge">TEMPLATE?</span>' : '';
      const newerLabel = p.likelyNewer === 'A' ? `▶ ${shortName(p.docA)}`
                       : p.likelyNewer === 'B' ? `▶ ${shortName(p.docB)}` : '?';
      const mA = docMeta(p.docA);
      const mB = docMeta(p.docB);
      return `<tr data-conf="${p.confidence}">
        <td><span class="score-badge" style="background:${scoreColor(p.score)}">${p.score}</span></td>
        <td><span class="conf-badge" style="color:${confColor}">${p.confidence}</span></td>
        <td>
          <div class="doc-name-cell">
            <a class="doc-link" href="#" data-path="${ea(p.docA)}">${esc(shortName(p.docA))}${flagNote}</a>
            <span class="doc-meta-tag">${esc(mA.ext.toUpperCase())}${mA.type ? ' · ' + esc(mA.type) : ''}</span>
          </div>
        </td>
        <td>
          <div class="doc-name-cell">
            <a class="doc-link" href="#" data-path="${ea(p.docB)}">${esc(shortName(p.docB))}</a>
            <span class="doc-meta-tag">${esc(mB.ext.toUpperCase())}${mB.type ? ' · ' + esc(mB.type) : ''}</span>
          </div>
        </td>
        <td style="font-size:.82em;color:#a0a4ab">${esc(newerLabel)}</td>
      </tr>`;
    })
    .join('');

  const chainSvg = chains.length > 0 ? buildChainSvg(chains) : buildChainSvgFromPairs(highPairs);

  return `<section class="version-analysis">
    <h2>Version Pairs & Clustering</h2>
    <p class="section-desc">${pairs.length} total pairs &bull; ${highPairs.length} HIGH &bull; ${medPairs.length} MEDIUM &bull; ${chains.length} chains detected</p>
    <div class="distribution-grid">
      <div class="chart-container">
        <h3>Score Histogram</h3>
        <canvas id="version-histogram-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Version Chains (HIGH confidence)</h3>
        <div class="chain-viz">${chainSvg}</div>
      </div>
    </div>

    <div class="pairs-table">
      <h3>Pairs — click any document name to inspect its full data</h3>
      <div class="filter-tabs">
        <button class="filter-tab active" data-conf-tab="HIGH">HIGH <span style="opacity:.7">(${highCount})</span></button>
        <button class="filter-tab" data-conf-tab="MEDIUM">MEDIUM <span style="opacity:.7">(${medCount})</span></button>
        <button class="filter-tab" data-conf-tab="ALL">ALL <span style="opacity:.7">(${shownPairs.length})</span></button>
      </div>
      <div class="table-search-wrap">
        <input class="table-search" type="search" placeholder="Filter by filename…" data-table="pairs-table-data">
        <span class="table-search-count"></span>
      </div>
      <table id="pairs-table-data">
        <thead><tr><th>Score</th><th>Conf.</th><th>Document A</th><th>Document B</th><th>Likely Newer</th></tr></thead>
        <tbody>${pairRows}</tbody>
      </table>
      ${shownPairs.length === 300 ? '<p class="section-desc" style="margin-top:.5rem">Showing top 300 pairs by score. Download JSON for complete dataset.</p>' : ''}
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart !== 'undefined') {
        new Chart(document.getElementById('version-histogram-chart'), {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(buckets.map((b) => b.label))},
            datasets: [{ data: ${JSON.stringify(bucketData)}, backgroundColor: ${JSON.stringify(buckets.map((b) => b.color))}, borderWidth: 0 }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { grid: { display: false } } },
          },
        });
      }

      // Confidence filter tabs
      var tabs = document.querySelectorAll('[data-conf-tab]');
      var allRows = document.querySelectorAll('#pairs-table-data tbody tr');

      function applyConfFilter(val) {
        var vis = 0;
        allRows.forEach(function(row) {
          var show = val === 'ALL' || row.dataset.conf === val;
          row.classList.toggle('row-hidden', !show);
          if (show) vis++;
        });
        tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.confTab === val); });
        var countEl = document.querySelector('#pairs-table-data')
          .closest('.pairs-table').querySelector('.table-search-count');
        if (countEl) countEl.textContent = vis + ' rows';
      }

      tabs.forEach(function(tab) {
        tab.addEventListener('click', function() { applyConfFilter(tab.dataset.confTab); });
      });

      // Start with HIGH visible only
      applyConfFilter('HIGH');
    });
  </script>`;
}

function scoreColor(score: number): string {
  if (score >= 10) return '#43a047';
  if (score >= 7)  return '#8bc34a';
  if (score >= 5)  return '#ff9800';
  return '#607d8b';
}

function shortName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.length > 30 ? base.slice(0, 27) + '…' : base;
}

function ea(s: string)  { return s.replace(/"/g, '&quot;'); }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] ?? m));
}

function buildChainSvg(chains: string[][]): string {
  return buildNetworkSvg(chains);
}

function buildChainSvgFromPairs(pairs: Array<{ docA: string; docB: string }>): string {
  if (pairs.length === 0) return '<p class="empty-state">No HIGH confidence pairs.</p>';
  const adj = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  };
  pairs.forEach((p) => addEdge(p.docA, p.docB));

  const visited = new Set<string>();
  const chains: string[][] = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const chain: string[] = [];
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur); chain.push(cur);
      adj.get(cur)!.forEach((n) => { if (!visited.has(n)) q.push(n); });
    }
    chains.push(chain);
  }
  return buildNetworkSvg(chains);
}

function buildNetworkSvg(chains: string[][]): string {
  const maxChains = chains.slice(0, 30); // cap SVG size
  const colW = 180; const rowH = 48; const nodeW = 160; const nodeH = 30;
  const maxCols = Math.max(...maxChains.map((c) => c.length), 1);
  const W = maxCols * colW + 20;
  const H = maxChains.length * rowH + 16;

  let rects = ''; let lines = '';
  maxChains.forEach((chain, row) => {
    const y = row * rowH + rowH / 2 + 8;
    chain.forEach((name, col) => {
      const x = col * colW + 10;
      const label = shortName(name);
      rects += `<rect x="${x}" y="${y - nodeH/2}" width="${nodeW}" height="${nodeH}" rx="3" fill="#1a2030" stroke="#ff6b35" stroke-width="1"/>
<text x="${x + nodeW/2}" y="${y + 4}" text-anchor="middle" font-family="monospace" font-size="10" fill="#e4e6eb">${xmlEsc(label)}</text>`;
      if (col > 0) {
        const px = (col - 1) * colW + nodeW + 10;
        lines += `<line x1="${px}" y1="${y}" x2="${x}" y2="${y}" stroke="#2a3038" stroke-width="1" marker-end="url(#arr)"/>`;
      }
    });
  });
  const note = chains.length > 30 ? `<text x="10" y="${H - 4}" font-family="monospace" font-size="9" fill="#607d8b">…${chains.length - 30} more chains not shown</text>` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;overflow:auto;max-height:240px">
    <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3z" fill="#2a3038"/></marker></defs>
    ${lines}${rects}${note}
  </svg>`;
}

function xmlEsc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
