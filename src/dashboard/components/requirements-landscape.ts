import type { ReportData } from '../lib/report-types.js';

export async function renderRequirementsLandscape(data: ReportData): Promise<string> {
  const reqs = data.requirements;

  if (reqs.length === 0) {
    return `<section class="requirements-landscape">
      <h2>Requirements Landscape</h2>
      <p class="empty-state">No requirements extracted from this corpus.</p>
    </section>`;
  }

  const typeCounts: Record<string, number> = {};
  const catCounts:  Record<string, number> = {};
  let safetyCount = 0;

  reqs.forEach((r) => {
    typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;
    catCounts[r.category] = (catCounts[r.category] ?? 0) + 1;
    if (r.isSafetyRelevant) safetyCount++;
  });

  const TYPE_COLORS: Record<string, string> = {
    MUSS: '#d32f2f', SOLL: '#ff6b35', KANN: '#1e88e5', DEKLARATIV: '#43a047', INFORMATIV: '#607d8b',
  };
  const typeLabels = Object.keys(typeCounts);
  const typeData   = Object.values(typeCounts);
  const typeColors = typeLabels.map((t) => TYPE_COLORS[t] ?? '#607d8b');

  const catLabels = Object.keys(catCounts);
  const catData   = Object.values(catCounts);
  const CAT_COLORS = ['#ff6b35', '#1e88e5', '#43a047', '#9c27b0', '#00bcd4', '#d32f2f', '#ff9800'];

  const safetyBanner = safetyCount > 0
    ? `<div class="safety-badge">
        <span class="safety-icon">⚠</span>
        <span>${safetyCount} requirement${safetyCount !== 1 ? 's' : ''} flagged safety-critical — manual review required</span>
      </div>`
    : '';

  const llm = data.llmValidation;
  const llmNote = llm
    ? `<p class="section-desc">LLM validation: ${llm.sampledDocIds.length} docs sampled &bull; regex/LLM delta ${(llm.regexVsLlmDelta * 100).toFixed(1)}%${llm.llmRecoveredCount ? ` &bull; ${llm.llmRecoveredCount} recovered by LLM` : ''}</p>`
    : '';

  // Type tabs — dynamically ordered by count desc
  const typesSorted = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const typeTabs = ['ALL', ...typesSorted]
    .map((t) => {
      const count = t === 'ALL' ? reqs.length : (typeCounts[t] ?? 0);
      return `<button class="filter-tab${t === 'ALL' ? ' active' : ''}" data-req-type-tab="${t}">${t} <span style="opacity:.7">(${count})</span></button>`;
    })
    .join('');

  return `<section class="requirements-landscape">
    <h2>Requirements Landscape</h2>
    ${safetyBanner}
    <p class="section-desc">${reqs.length.toLocaleString()} requirements extracted across ${typeLabels.length} types</p>
    ${llmNote}

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

    <div class="req-table-section">
      <h3>All Requirements — click any document name to inspect</h3>
      <div class="req-table-controls">
        <div class="filter-tabs" style="margin-bottom:0">${typeTabs}</div>
        <button class="filter-tab" id="req-safety-toggle">⚠ Safety only</button>
      </div>
      <div class="table-search-wrap" style="margin-top:.75rem">
        <input id="req-search" class="table-search" type="search" placeholder="Search section heading, doc, category…">
        <span id="req-visible-count" class="table-search-count"></span>
      </div>
      <p id="req-count-note" class="section-desc" style="margin-top:.25rem"></p>
      <table id="req-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Category</th>
            <th style="text-align:center">Safety</th>
            <th>Source</th>
            <th>Section heading</th>
            <th>Document</th>
          </tr>
        </thead>
        <tbody id="req-tbody"><tr><td colspan="6" style="color:#607d8b;font-style:italic;text-align:center">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart !== 'undefined') {
        new Chart(document.getElementById('req-type-chart'), {
          type: 'bar',
          data: {
            labels: ${JSON.stringify(typeLabels)},
            datasets: [{ data: ${JSON.stringify(typeData)}, backgroundColor: ${JSON.stringify(typeColors)}, borderWidth: 0 }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } },
          },
        });

        new Chart(document.getElementById('req-cat-chart'), {
          type: 'doughnut',
          data: {
            labels: ${JSON.stringify(catLabels)},
            datasets: [{ data: ${JSON.stringify(catData)}, backgroundColor: ${JSON.stringify(CAT_COLORS.slice(0, catLabels.length))}, borderWidth: 2, borderColor: '#0f1419' }],
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { family: 'monospace', size: 11 }, padding: 8 } } } },
        });
      }

      // ── Requirements interactive table ──────────────────────────────
      var _data = window.__huginnData;
      if (!_data || !_data.requirements) return;

      var allReqs = _data.requirements;
      var LIMIT   = 1000;
      var tbody   = document.getElementById('req-tbody');

      // Build id → filename lookup
      var _parsedMap = new Map((_data.parsed || []).map(function(p){ return [p.id, p.filename]; }));
      var _filesMap  = new Map((_data.files  || []).map(function(f){ return [f.id, f.filename]; }));
      function docName(id){ return _parsedMap.get(id) || _filesMap.get(id) || id; }

      var TYPE_COLORS = {MUSS:'#d32f2f',SOLL:'#ff6b35',KANN:'#1e88e5',DEKLARATIV:'#43a047',INFORMATIV:'#607d8b'};
      function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

      var slice = allReqs.slice(0, LIMIT);
      tbody.innerHTML = slice.map(function(r){
        var col  = TYPE_COLORS[r.type] || '#607d8b';
        var safe = r.isSafetyRelevant ? '<span style="color:#d32f2f" title="Safety-critical">⚠</span>' : '';
        var src  = r.source ? r.source.replace('_',' ') : 'regex';
        var hdg  = r.sectionHeading ? _esc(r.sectionHeading.slice(0,70)) : '—';
        var fname = _esc(docName(r.docId).split('/').pop() || r.docId);
        return '<tr data-req-type="'+r.type+'" data-req-safety="'+r.isSafetyRelevant+'">'
          +'<td><span class="req-type-badge" style="background:'+col+'">'+r.type+'</span></td>'
          +'<td style="font-size:.85em">'+_esc(r.category||'—')+'</td>'
          +'<td style="text-align:center">'+safe+'</td>'
          +'<td style="font-size:.78em;color:#a0a4ab">'+_esc(src)+'</td>'
          +'<td style="font-size:.8em;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_esc(r.sectionHeading||'')+'">'+hdg+'</td>'
          +'<td><a class="doc-link" href="#" data-doc-id="'+_esc(r.docId)+'" style="font-size:.82em">'+fname+'</a></td>'
          +'</tr>';
      }).join('');

      var countNote = document.getElementById('req-count-note');
      if (countNote && allReqs.length > LIMIT) {
        countNote.textContent = 'Showing first '+LIMIT.toLocaleString()+' of '+allReqs.length.toLocaleString()+' — use filters or search to narrow down';
      }

      // Filter state
      var activeType  = 'ALL';
      var safetyOnly  = false;
      var searchText  = '';

      function applyFilters() {
        var rows = tbody.querySelectorAll('tr');
        var vis  = 0;
        rows.forEach(function(row) {
          var type   = row.dataset.reqType;
          var safety = row.dataset.reqSafety === 'true';
          var text   = row.textContent.toLowerCase();
          var show   = (activeType === 'ALL' || type === activeType)
                    && (!safetyOnly || safety)
                    && (!searchText || text.includes(searchText));
          row.classList.toggle('row-hidden', !show);
          if (show) vis++;
        });
        var el = document.getElementById('req-visible-count');
        if (el) el.textContent = vis+' / '+rows.length+' shown';
      }

      // Type tabs
      document.querySelectorAll('[data-req-type-tab]').forEach(function(tab) {
        tab.addEventListener('click', function() {
          activeType = tab.dataset.reqTypeTab;
          document.querySelectorAll('[data-req-type-tab]').forEach(function(t){
            t.classList.toggle('active', t === tab);
          });
          applyFilters();
        });
      });

      // Safety toggle
      var safeBtn = document.getElementById('req-safety-toggle');
      if (safeBtn) {
        safeBtn.addEventListener('click', function() {
          safetyOnly = !safetyOnly;
          safeBtn.classList.toggle('safety-active', safetyOnly);
          applyFilters();
        });
      }

      // Search
      var searchEl = document.getElementById('req-search');
      if (searchEl) {
        searchEl.addEventListener('input', function() {
          searchText = searchEl.value.toLowerCase().trim();
          applyFilters();
        });
      }

      applyFilters();
    });
  </script>`;
}
