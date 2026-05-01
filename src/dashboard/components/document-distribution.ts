import type { ReportData } from '../lib/report-types.js';

export async function renderDocumentDistribution(data: ReportData): Promise<string> {
  const s = data.summary;

  const sortedEntries = (obj: Record<string, number>, limit = 10) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);

  const extEntries  = sortedEntries(s.byExtension);
  const langEntries = sortedEntries(s.byLanguage);
  const typeEntries = sortedEntries(s.byDocType, 8);

  const ACCENT_COLORS = ['#ff6b35','#1e88e5','#43a047','#9c27b0','#00bcd4','#d32f2f','#ff9800','#607d8b','#e91e63','#795548'];

  const pageCounts = (data.parsed ?? []).map((d) => d.pageCount ?? 0).filter((n) => n > 0);
  const pageHistSrc = pageCounts.length > 0 ? JSON.stringify(pageCounts) : 'null';

  // Extension filter tabs — store lowercase key matching f.extension
  const extTabsHtml = ['ALL', ...extEntries.map(([k]) => k)]
    .map((t, i) => {
      const count = t === 'ALL' ? s.totalFiles : (s.byExtension[t] ?? 0);
      return `<button class="filter-tab${i === 0 ? ' active' : ''}" data-dist-ext-tab="${t}">${ea(t.toUpperCase())} <span style="opacity:.7">(${count})</span></button>`;
    })
    .join('');

  // Type filter tabs — store raw key (underscores), display with spaces
  const typeTabsHtml = typeEntries.length > 0
    ? ['ALL', ...typeEntries.map(([k]) => k)]
        .map((t, i) => {
          const count = t === 'ALL' ? s.totalFiles : (s.byDocType[t] ?? 0);
          return `<button class="filter-tab${i === 0 ? ' active' : ''}" data-dist-type-tab="${ea(t)}">${esc(t === 'ALL' ? 'ALL' : t.replace(/_/g, ' '))} <span style="opacity:.7">(${count})</span></button>`;
        })
        .join('')
    : '';

  // Type key array for Chart.js onClick reverse-lookup
  const typeKeysJson = JSON.stringify(typeEntries.map(([k]) => k));

  return `<section class="document-distribution">
    <h2>Document Distribution & Metadata</h2>
    <div class="dist-stat-row">
      <span class="dist-stat"><strong>${s.totalFiles}</strong> total files</span>
      <span class="dist-stat"><strong>${s.parsedFiles}</strong> parsed</span>
      <span class="dist-stat"><strong>${s.parseFailures}</strong> failed</span>
      <span class="dist-stat"><strong>${s.scannedPdfs}</strong> scanned PDFs</span>
      <span class="dist-stat"><strong>${s.ocrRequired}</strong> need OCR</span>
    </div>
    <p class="section-desc" style="margin-top:-.5rem">Click any chart bar or filter tab below to browse documents in that category.</p>
    <div class="distribution-grid">
      <div class="chart-container">
        <h3>File Types</h3>
        <canvas id="ext-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Languages</h3>
        <canvas id="lang-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Document Types</h3>
        <canvas id="doctype-chart"></canvas>
      </div>
      ${pageCounts.length > 0 ? `<div class="chart-container">
        <h3>Page Count Distribution</h3>
        <canvas id="pages-chart"></canvas>
      </div>` : ''}
    </div>

    <!-- Document browser — populated by JS from embedded data, zero network requests -->
    <div class="doc-browser">
      <h3>All Documents — click filename to inspect full data</h3>
      <div class="dist-filter-row">
        <span class="dist-filter-label">Extension</span>
        <div class="filter-tabs" style="margin-bottom:0">${extTabsHtml}</div>
      </div>
      ${typeEntries.length > 0 ? `<div class="dist-filter-row">
        <span class="dist-filter-label">Doc Type</span>
        <div class="filter-tabs" style="margin-bottom:0">${typeTabsHtml}</div>
      </div>` : ''}
      <div class="table-search-wrap" style="margin-top:.75rem">
        <input id="dist-search" class="table-search" type="search" placeholder="Search filename, path, customer, project…">
        <span id="dist-count" class="table-search-count"></span>
      </div>
      <table id="dist-doc-table">
        <thead>
          <tr>
            <th>Filename</th>
            <th>Ext</th>
            <th style="text-align:right">Size</th>
            <th style="text-align:right">~Tokens</th>
            <th>Doc Type</th>
            <th>Language</th>
            <th style="text-align:right">Pages</th>
            <th>Category</th>
          </tr>
        </thead>
        <tbody id="dist-tbody"><tr><td colspan="8" style="color:#607d8b;font-style:italic;text-align:center">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // ── Document browser ─────────────────────────────────────────────────────
      var _d = window.__huginnData;
      var allFiles = _d && _d.files ? _d.files : [];
      var parsedMap = new Map((_d && _d.parsed ? _d.parsed : []).map(function(p){ return [p.id, p]; }));
      var LIMIT = 500;
      var tbody  = document.getElementById('dist-tbody');
      var countEl = document.getElementById('dist-count');
      var activeExt  = 'ALL';
      var activeType = 'ALL';
      var searchText = '';

      function _bytes(b){ b=b||0; if(b<1024)return b+' B'; if(b<1048576)return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
      function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

      function applyFilters() {
        var filtered = allFiles.filter(function(f) {
          var p = parsedMap.get(f.id);
          var extOk  = activeExt  === 'ALL' || (f.extension||'') === activeExt;
          var typeOk = activeType === 'ALL' || (p && p.detectedDocType === activeType);
          var txt = ((f.filename||'') + ' ' + (f.path||'') + ' ' + (f.inferredCustomer||'') + ' ' + (f.inferredProject||'')).toLowerCase();
          return extOk && typeOk && (!searchText || txt.includes(searchText));
        });
        var slice = filtered.slice(0, LIMIT);
        tbody.innerHTML = slice.map(function(f) {
          var p = parsedMap.get(f.id);
          var tokens = Math.round((f.sizeBytes||0) / 4);
          var tokStr = tokens >= 1000 ? (tokens/1000).toFixed(1)+'k' : String(tokens);
          return '<tr>'
            +'<td><a class="doc-link" href="#" data-path="'+_esc(f.path)+'" style="font-size:.85em">'+_esc(f.filename)+'</a></td>'
            +'<td style="font-size:.8em;color:#a0a4ab">'+_esc((f.extension||'').toUpperCase())+'</td>'
            +'<td style="text-align:right;font-size:.8em;font-family:monospace">'+_bytes(f.sizeBytes)+'</td>'
            +'<td style="text-align:right;font-size:.8em;font-family:monospace">~'+tokStr+'</td>'
            +'<td style="font-size:.8em">'+_esc((p&&p.detectedDocType)||'—')+'</td>'
            +'<td style="font-size:.8em;text-transform:uppercase">'+_esc((p&&p.language)||'—')+'</td>'
            +'<td style="text-align:right;font-size:.8em">'+((p&&p.pageCount)||'—')+'</td>'
            +'<td style="font-size:.8em;color:#a0a4ab">'+_esc(f.inferredDocumentCategory||'—')+'</td>'
            +'</tr>';
        }).join('');
        if (countEl) {
          countEl.textContent = filtered.length > LIMIT
            ? 'first '+LIMIT+' of '+filtered.length+' files'
            : filtered.length+' '+(filtered.length===1?'file':'files');
        }
      }

      function filterByExt(ext) {
        activeExt = ext;
        document.querySelectorAll('[data-dist-ext-tab]').forEach(function(t){
          t.classList.toggle('active', t.dataset.distExtTab === ext);
        });
        applyFilters();
      }

      function filterByType(type) {
        activeType = type;
        document.querySelectorAll('[data-dist-type-tab]').forEach(function(t){
          t.classList.toggle('active', t.dataset.distTypeTab === type);
        });
        applyFilters();
      }

      document.querySelectorAll('[data-dist-ext-tab]').forEach(function(tab) {
        tab.addEventListener('click', function(){ filterByExt(tab.dataset.distExtTab); });
      });
      document.querySelectorAll('[data-dist-type-tab]').forEach(function(tab) {
        tab.addEventListener('click', function(){ filterByType(tab.dataset.distTypeTab); });
      });
      var searchEl = document.getElementById('dist-search');
      if (searchEl) {
        searchEl.addEventListener('input', function(){
          searchText = searchEl.value.toLowerCase().trim();
          applyFilters();
        });
      }
      applyFilters();

      // ── Charts ───────────────────────────────────────────────────────────────
      if (typeof Chart === 'undefined') return;

      var _typeKeys = ${typeKeysJson};

      function _hoverCursor(evt, els) {
        if (evt.native) evt.native.target.style.cursor = els && els.length ? 'pointer' : '';
      }

      new Chart(document.getElementById('ext-chart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(extEntries.map(([k]) => k.toUpperCase()))},
          datasets: [{ data: ${JSON.stringify(extEntries.map(([,v]) => v))}, backgroundColor: '${ACCENT_COLORS[0]}', borderWidth: 0 }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: { legend: { display: false } },
          onClick: function(evt, els, chart) {
            if (els && els.length > 0) filterByExt(chart.data.labels[els[0].index].toLowerCase());
          },
          onHover: _hoverCursor,
          scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } },
        },
      });

      new Chart(document.getElementById('lang-chart'), {
        type: 'doughnut',
        data: {
          labels: ${JSON.stringify(langEntries.map(([k]) => k.toUpperCase()))},
          datasets: [{ data: ${JSON.stringify(langEntries.map(([,v]) => v))}, backgroundColor: ${JSON.stringify(ACCENT_COLORS.slice(0, langEntries.length))}, borderWidth: 2, borderColor: '#0f1419' }],
        },
        options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { family: 'monospace', size: 11 }, padding: 10 } } } },
      });

      new Chart(document.getElementById('doctype-chart'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(typeEntries.map(([k]) => k.replace(/_/g,' ')))},
          datasets: [{ data: ${JSON.stringify(typeEntries.map(([,v]) => v))}, backgroundColor: '${ACCENT_COLORS[1]}', borderWidth: 0 }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          plugins: { legend: { display: false } },
          onClick: function(evt, els) {
            if (els && els.length > 0) filterByType(_typeKeys[els[0].index] || 'ALL');
          },
          onHover: _hoverCursor,
          scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } },
        },
      });

      ${pageCounts.length > 0 ? `
      var pages = ${pageHistSrc};
      var buckets = [[1,10,'1-10'],[11,20,'11-20'],[21,50,'21-50'],[51,100,'51-100'],[101,200,'101-200'],[201,999,'200+']];
      var counts = buckets.map(function(b){ return pages.filter(function(p){ return p >= b[0] && p <= b[1]; }).length; });
      new Chart(document.getElementById('pages-chart'), {
        type: 'bar',
        data: {
          labels: buckets.map(function(b){ return b[2]; }),
          datasets: [{ data: counts, backgroundColor: '${ACCENT_COLORS[2]}', borderWidth: 0 }],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
      });` : ''}
    });
  </script>`;
}

function ea(s: string) { return s.replace(/"/g, '&quot;'); }
function esc(s: string) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m] ?? m));
}
