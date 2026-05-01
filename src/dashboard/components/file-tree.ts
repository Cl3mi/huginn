import type { ReportData } from '../lib/report-types.js';

// ── Server-side data computation ────────────────────────────────────────────

interface HeadingCharts {
  countBuckets:  { label: string; count: number }[];
  depthCounts:   number[];          // index 0 = h1 … index 5 = h6
  avgTokenHist:  { label: string; count: number }[];
  totalHeadings: number;
  docsWithHeadings: number;
}

function computeHeadingCharts(data: ReportData): HeadingCharts {
  const parsed = data.parsed ?? [];

  // 1. Heading count per document — buckets
  const countBucketDefs: [number, number, string][] = [
    [1,   5,   '1–5'],
    [6,   20,  '6–20'],
    [21,  50,  '21–50'],
    [51,  150, '51–150'],
    [151, 500, '151–500'],
    [501, Infinity, '500+'],
  ];
  const countBuckets = countBucketDefs.map(([lo, hi, label]) => ({ label, count: 0 }));
  let docsWithHeadings = 0;

  // 2. Depth distribution h1–h6
  const depthCounts = [0, 0, 0, 0, 0, 0];

  // 3. Average tokens per section — per-doc average, then histogram
  const avgTokenBucketDefs: [number, number, string][] = [
    [0,  3,  '≤3'],
    [4,  6,  '4–6'],
    [7,  10, '7–10'],
    [11, 15, '11–15'],
    [16, 30, '16–30'],
    [31, Infinity, '31+'],
  ];
  const avgTokenHist = avgTokenBucketDefs.map(([, , label]) => ({ label, count: 0 }));

  for (const p of parsed) {
    const headings = p.headings ?? [];
    if (headings.length === 0) continue;
    docsWithHeadings++;

    // count buckets
    const n = headings.length;
    for (let i = 0; i < countBucketDefs.length; i++) {
      const def = countBucketDefs[i];
      if (!def) continue;
      const [lo, hi] = def;
      if (n >= lo && n <= hi) { const b = countBuckets[i]; if (b) b.count++; break; }
    }

    // depth
    for (const h of headings) {
      const lvl = Math.max(1, Math.min(6, h.level ?? 1));
      depthCounts[lvl - 1] = (depthCounts[lvl - 1] ?? 0) + 1;
    }

    // avg tokens/section for this doc
    const avgTok = headings.reduce((s, h) => s + (h.approximateTokens ?? 0), 0) / headings.length;
    for (let i = 0; i < avgTokenBucketDefs.length; i++) {
      const def = avgTokenBucketDefs[i];
      if (!def) continue;
      const [lo, hi] = def;
      if (avgTok >= lo && avgTok <= hi) { const b = avgTokenHist[i]; if (b) b.count++; break; }
    }
  }

  const totalHeadings = depthCounts.reduce((s, n) => s + n, 0);
  return { countBuckets, depthCounts, avgTokenHist, totalHeadings, docsWithHeadings };
}

// ── Component ────────────────────────────────────────────────────────────────

const ACCENT = ['#ff6b35', '#1e88e5', '#43a047', '#9c27b0', '#00bcd4', '#d32f2f'];

export async function renderFileTree(data: ReportData): Promise<string> {
  const files = data.files ?? [];
  const total = files.length;
  const roots = [...new Set(files.map((f) => f.path.split('/')[0]))].sort();
  const hc    = computeHeadingCharts(data);

  const countLabels  = JSON.stringify(hc.countBuckets.map((b) => b.label));
  const countData    = JSON.stringify(hc.countBuckets.map((b) => b.count));
  const depthLabels  = JSON.stringify(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const depthData    = JSON.stringify(hc.depthCounts);
  const depthColors  = JSON.stringify(ACCENT.slice(0, 6));
  const tokLabels    = JSON.stringify(hc.avgTokenHist.map((b) => b.label));
  const tokData      = JSON.stringify(hc.avgTokenHist.map((b) => b.count));

  return `<section class="file-tree-section">
    <h2>Document Base Tree &amp; Heading Analysis</h2>
    <p class="section-desc">${total} files &bull; ${hc.docsWithHeadings} with headings &bull; ${hc.totalHeadings.toLocaleString()} total headings extracted &mdash; all data stays local.</p>

    <!-- Heading charts -->
    <div class="distribution-grid" style="margin-bottom:2rem">
      <div class="chart-container">
        <h3>Headings per Document</h3>
        <canvas id="hc-count-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Heading Depth Distribution</h3>
        <canvas id="hc-depth-chart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Avg Tokens per Section</h3>
        <canvas id="hc-tok-chart"></canvas>
      </div>
    </div>

    <!-- Tree -->
    <div class="tree-toolbar">
      <button class="tree-btn" id="tree-expand-all">Expand all</button>
      <button class="tree-btn" id="tree-collapse-all">Collapse all</button>
      <span style="flex:1"></span>
      <input id="tree-search" class="table-search" type="search" placeholder="Filter files…" style="max-width:260px">
      <span id="tree-match-count" class="table-search-count"></span>
    </div>
    <div id="file-tree-root" class="file-tree"></div>
  </section>

  <script>
  document.addEventListener('DOMContentLoaded', function() {
    // ── Charts ───────────────────────────────────────────────────────────────
    if (typeof Chart !== 'undefined') {
      var _hoverCursor = function(evt, els) {
        if (evt.native) evt.native.target.style.cursor = els && els.length ? 'pointer' : '';
      };
      var _chartOpts = function(indexAxis) {
        return {
          indexAxis: indexAxis || 'x',
          responsive: true,
          plugins: { legend: { display: false } },
          onHover: _hoverCursor,
          scales: {
            x: { beginAtZero: true, grid: { display: indexAxis === 'y' ? false : true }, ticks: { stepSize: 1 } },
            y: { beginAtZero: true, grid: { display: indexAxis === 'y' ? true  : false }, ticks: { stepSize: 1 } },
          },
        };
      };

      new Chart(document.getElementById('hc-count-chart'), {
        type: 'bar',
        data: {
          labels: ${countLabels},
          datasets: [{ data: ${countData}, backgroundColor: '${ACCENT[1]}', borderWidth: 0 }],
        },
        options: _chartOpts('x'),
      });

      new Chart(document.getElementById('hc-depth-chart'), {
        type: 'bar',
        data: {
          labels: ${depthLabels},
          datasets: [{ data: ${depthData}, backgroundColor: ${depthColors}, borderWidth: 0 }],
        },
        options: _chartOpts('x'),
      });

      new Chart(document.getElementById('hc-tok-chart'), {
        type: 'bar',
        data: {
          labels: ${tokLabels},
          datasets: [{ data: ${tokData}, backgroundColor: '${ACCENT[2]}', borderWidth: 0 }],
        },
        options: _chartOpts('x'),
      });
    }

    // ── File tree ────────────────────────────────────────────────────────────
    var _d = window.__huginnData;
    var allFiles = (_d && _d.files) ? _d.files : [];
    var parsedMap = new Map((_d && _d.parsed ? _d.parsed : []).map(function(p){ return [p.id, p]; }));

    function buildTree(files) {
      var root = { __files: [], __dirs: Object.create(null) };
      files.forEach(function(f) {
        var parts = f.path.split('/');
        var node = root;
        for (var i = 0; i < parts.length - 1; i++) {
          if (!node.__dirs[parts[i]]) node.__dirs[parts[i]] = { __files: [], __dirs: Object.create(null) };
          node = node.__dirs[parts[i]];
        }
        node.__files.push(f);
      });
      return root;
    }

    function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
    function _bytes(b){ b=b||0; if(b<1024)return b+' B'; if(b<1048576)return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }

    var EXT_COLORS = { '.pdf':'#d32f2f', '.xlsx':'#43a047', '.docx':'#1e88e5', '.pptx':'#ff9800', '.doc':'#1565c0', '.csv':'#00bcd4', '.txt':'#9c27b0' };

    function extBadge(ext) {
      var c = EXT_COLORS[ext] || '#607d8b';
      return '<span class="tree-ext-badge" style="background:'+c+'20;color:'+c+';border-color:'+c+'50">'+_esc((ext||'?').toUpperCase().replace('.',''))+'</span>';
    }

    function subtreeFileCount(node) {
      var count = node.__files.length;
      Object.keys(node.__dirs).forEach(function(k){ count += subtreeFileCount(node.__dirs[k]); });
      return count;
    }

    function subtreeHasMatch(node, q) {
      if (node.__files.some(function(f){ return f.path.toLowerCase().includes(q); })) return true;
      return Object.keys(node.__dirs).some(function(k){ return subtreeHasMatch(node.__dirs[k], q); });
    }

    function renderNode(node, filterText) {
      var html = '';

      Object.keys(node.__dirs).sort().forEach(function(name) {
        var child = node.__dirs[name];
        if (filterText && !subtreeHasMatch(child, filterText)) return;
        var count = subtreeFileCount(child);
        var childHtml = renderNode(child, filterText);
        html += '<details class="tree-dir"'+(filterText?' open':'')+'>'
          +'<summary class="tree-dir-summary">'
          +'<span class="tree-arrow"></span>'
          +'<span class="tree-dir-icon">&#128193;</span>'
          +'<span class="tree-dir-name">'+_esc(name)+'</span>'
          +'<span class="tree-dir-count">'+count+' file'+(count===1?'':'s')+'</span>'
          +'</summary>'
          +'<div class="tree-children">'+childHtml+'</div>'
          +'</details>';
      });

      node.__files.forEach(function(f) {
        if (filterText && !f.path.toLowerCase().includes(filterText)) return;
        var p = parsedMap.get(f.id);
        var headCount = (p && p.headings) ? p.headings.length : (p && p.headingCount ? p.headingCount : null);
        var headBadge = headCount != null ? '<span class="tree-meta" title="headings">&#35;'+headCount+'h</span>' : '';
        var pages = (p && p.pageCount) ? '<span class="tree-meta">'+p.pageCount+'p</span>' : '';
        var size  = '<span class="tree-meta mono">'+_bytes(f.sizeBytes)+'</span>';
        var dtype = (p && p.detectedDocType) ? '<span class="tree-doctype">'+_esc(p.detectedDocType.replace(/_/g,' '))+'</span>' : '';
        html += '<div class="tree-file">'
          +'<span class="tree-file-icon">&#128196;</span>'
          +'<a class="doc-link" href="#" data-path="'+_esc(f.id)+'">'+_esc(f.filename)+'</a>'
          +extBadge(f.extension)
          +headBadge+pages+size+dtype
          +'</div>';
      });

      return html;
    }

    var treeRoot = document.getElementById('file-tree-root');
    var matchCount = document.getElementById('tree-match-count');

    function renderTree(q) {
      var tree = buildTree(allFiles);
      treeRoot.innerHTML = renderNode(tree, q);
      if (q) {
        var shown = treeRoot.querySelectorAll('.tree-file').length;
        matchCount.textContent = shown + ' match' + (shown===1?'':'es');
      } else {
        matchCount.textContent = allFiles.length + ' files';
      }
    }

    renderTree('');

    document.getElementById('tree-search').addEventListener('input', function() {
      renderTree(this.value.toLowerCase().trim());
    });
    document.getElementById('tree-expand-all').addEventListener('click', function() {
      treeRoot.querySelectorAll('details').forEach(function(d){ d.open = true; });
    });
    document.getElementById('tree-collapse-all').addEventListener('click', function() {
      treeRoot.querySelectorAll('details').forEach(function(d){ d.open = false; });
    });
  });
  </script>`;
}
