// Standalone CLI: bun src/phases/10-html.ts <path-to-scan-report.json>
// Reads JSON report, generates self-contained HTML dashboard alongside it.
import { readFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: bun src/phases/10-html.ts <path-to-scan-report.json>");
    process.exit(1);
  }

  const json = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(json) as Record<string, unknown>;

  const html = generateHtml(data, json);

  const outPath = join(dirname(jsonPath), basename(jsonPath, ".json") + ".html");
  writeFileSync(outPath, html, "utf-8");
  console.log(`HTML report written to: ${outPath}`);
}

function generateHtml(data: Record<string, unknown>, rawJson: string): string {
  // Prevent </script> in embedded JSON from breaking the page
  const safeJson = rawJson.replace(/<\/script>/gi, "<\\/script>");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Huginn Dashboard — ${esc(String(data.scanId ?? ""))}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>${CSS}</style>
</head>
<body>
<script id="report-data" type="application/json">${safeJson}</script>
<script>(function(){var _el=document.getElementById('report-data');var _d={};try{_d=_el?JSON.parse(_el.textContent||'{}'):{};}catch(e){}window.__huginnData=_d;})();</script>
<div class="container">
  ${sectionHeader(data)}
  ${sectionMuninnConfig(data)}
  ${sectionQualityGauge(data)}
  ${sectionDocDistribution(data)}
  ${sectionIngestionIntelligence(data)}
  ${sectionFileTree(data)}
  ${sectionVersionPairs(data)}
  ${sectionRequirements(data)}
  ${sectionReferences(data)}
  ${sectionParseHealth(data)}
  ${sectionBoilerplateDiscovery(data)}
  ${sectionConsistencyChecks(data)}
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background-color:#0f1419;color:#e4e6eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;font-size:14px}
h1,h2,h3,h4{font-family:"IBM Plex Mono","Fira Code",monospace;font-weight:600;margin-top:1.5em;margin-bottom:.75em;letter-spacing:.5px}
h1{font-size:2em}h2{font-size:1.4em}h3{font-size:1.1em}
a{color:#ff6b35;text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:1400px;margin:0 auto;padding:2rem}
#quick-nav{display:none}
@media(min-width:1700px){#quick-nav{display:flex;flex-direction:column;position:fixed;right:1.25rem;top:50%;transform:translateY(-50%);z-index:200;background:rgba(26,31,38,.97);border:1px solid #2a3038;border-radius:8px;padding:.65rem .4rem;gap:.1rem;max-height:90vh;overflow-y:auto;backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,.5)}}
.qnav-label{font-size:.58em;letter-spacing:2px;text-transform:uppercase;color:#a0a4ab;padding:.1rem .6rem .5rem;font-family:"IBM Plex Mono","Fira Code",monospace;white-space:nowrap;border-bottom:1px solid #2a3038;margin-bottom:.3rem}
.qnav-link{display:block;font-size:.7em;font-family:"IBM Plex Mono","Fira Code",monospace;color:#a0a4ab;text-decoration:none;padding:.3rem .6rem;border-radius:4px;border-left:2px solid transparent;white-space:nowrap;max-width:170px;overflow:hidden;text-overflow:ellipsis;transition:color .12s,border-color .12s,background .12s}
.qnav-link:hover{color:#e4e6eb;background:rgba(255,255,255,.04)}.qnav-link.qnav-active{color:#ff6b35;border-left-color:#ff6b35}
section{background-color:#1a1f26;border:1px solid #2a3038;border-radius:4px;padding:1.5rem;margin-bottom:2rem}
.dashboard-header{background:linear-gradient(135deg,#1a1f26 0%,#0f1419 100%);border-left:4px solid #ff6b35;padding:2rem;margin-bottom:2rem;display:flex;justify-content:space-between;align-items:flex-start;gap:2rem}
.header-content{flex:1}
.header-logo{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.75em;letter-spacing:4px;text-transform:uppercase;color:#ff6b35;opacity:.7;margin-bottom:.4rem}
.header-scan-id{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:1.4em;margin:0 0 .3rem 0;color:#e4e6eb}
.timestamp{color:#a0a4ab;font-size:.85em;margin-top:0}
.header-metrics{display:flex;gap:1rem;flex-wrap:wrap;justify-content:flex-end}
.header-metric{background-color:#1a1f26;border:1px solid #2a3038;padding:.9rem 1.2rem;border-radius:4px;min-width:120px;text-align:center;display:flex;flex-direction:column;gap:.2rem}
.hm-label{font-size:.7em;text-transform:uppercase;color:#a0a4ab;letter-spacing:1.5px}
.hm-value{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:1.6em;font-weight:700;line-height:1}
.hm-unit{font-size:.5em;font-weight:400;color:#a0a4ab}
.hm-sub{font-size:.75em;color:#a0a4ab}
.section-desc{color:#a0a4ab;font-size:.9em;margin:-.25rem 0 1.25rem 0}
.empty-state{color:#a0a4ab;font-style:italic;padding:1.25rem 0}
.kpi-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;background:none;border:none;padding:0;margin-bottom:2rem}
.kpi-card{background-color:#1a1f26;border:1px solid #2a3038;border-top:3px solid var(--kpi-accent,#ff6b35);padding:1.25rem 1rem;border-radius:4px;display:flex;flex-direction:column;gap:.3rem;cursor:pointer;transition:border-color .15s,transform .1s}
.kpi-card:hover{border-color:var(--kpi-accent,#ff6b35);transform:translateY(-1px)}
.kpi-icon{width:20px;height:20px;margin-bottom:.25rem;flex-shrink:0}.kpi-icon svg{width:100%;height:100%;display:block}
.kpi-label{font-size:.7em;color:#a0a4ab;text-transform:uppercase;letter-spacing:1.5px}
.kpi-value{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:1.9em;font-weight:700;line-height:1}
.kpi-denom{font-size:.5em;font-weight:400;color:#a0a4ab}
.kpi-sub{font-size:.8em;color:#a0a4ab;margin-top:.1rem}
canvas{max-height:300px;margin:1rem auto;display:block}
.distribution-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:1.5rem}
.chart-container{background-color:#0f1419;padding:1rem;border-radius:4px;border:1px solid #2a3038}
.chart-container h3{font-size:.95em;margin:0 0 1rem 0;color:#a0a4ab;text-transform:uppercase;letter-spacing:1px}
.parse-health-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem;margin-bottom:2rem}
.parse-metric{background-color:#0f1419;padding:1rem;border-radius:4px;border:1px solid #2a3038}
.metric-label{font-size:.85em;color:#a0a4ab;text-transform:uppercase;letter-spacing:1px;margin-bottom:.75em}
.metric-gauge{height:24px;background-color:#2a3038;border-radius:4px;overflow:hidden;margin-bottom:.75em}
.gauge-bar{height:100%;transition:width .3s ease}
.metric-value{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:1.2em;font-weight:700;color:#ff6b35}
.parse-summary{background-color:#0f1419;padding:1rem;border-radius:4px;border-left:3px solid #ff6b35}
.parse-summary h3{margin:0 0 1rem 0}.parse-summary ul{list-style:none;padding:0}
.parse-summary li{padding:.5em 0;font-size:.95em}
.gauge-container{display:grid;grid-template-columns:auto 1fr;gap:2.5rem;align-items:start}
.gauge-chart-wrap{position:relative;width:220px;flex-shrink:0}
.gauge-center-text{position:absolute;bottom:8px;left:0;right:0;text-align:center;pointer-events:none}
.gauge-score{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:2.2em;font-weight:700;line-height:1}
.gauge-sub{font-size:.8em;color:#a0a4ab}
.gauge-components{display:flex;flex-direction:column;justify-content:center}
.component-table{margin:0}
.component-table td{padding:.45rem .6rem;font-size:.88em}
.mini-bar-wrap{height:8px;background:#2a3038;border-radius:4px;overflow:hidden;width:120px}
.mini-bar{height:100%;border-radius:4px}
.calibration-note{font-size:.8em;color:#a0a4ab;margin-top:.75rem;font-style:italic}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.9em}
thead{background-color:#0f1419;border-bottom:2px solid #ff6b35}
th{padding:.75rem;text-align:left;text-transform:uppercase;font-size:.8em;letter-spacing:1px;color:#a0a4ab}
td{padding:.75rem;border-bottom:1px solid #2a3038}
tbody tr:hover{background-color:#0f1419}
.badge{display:inline-block;padding:.25em .75em;border-radius:3px;font-size:.85em;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge.success{background-color:#43a047;color:#0f1419}.badge.warning{background-color:#ff6b35;color:#0f1419}
.badge.danger{background-color:#d32f2f;color:white}.badge.info{background-color:#1e88e5;color:white}
.collapsible{cursor:pointer;background-color:#0f1419;padding:1rem;border-left:2px solid #ff6b35;user-select:none}
.collapsible:hover{background-color:#2a3038}
.collapsible::before{content:'▸ ';color:#ff6b35;font-weight:bold;margin-right:.5rem}
.collapsible.active::before{content:'▾ '}
.collapsible-content{display:none;padding:1rem;background-color:#0f1419;border-left:2px solid #ff6b35}
.collapsible.active + .collapsible-content{display:block}
.btn{display:inline-block;padding:.5em 1.5em;margin:.5em .5em .5em 0;border:1px solid #2a3038;border-radius:4px;background-color:#1a1f26;color:#e4e6eb;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.9em;cursor:pointer;transition:all .2s ease;text-decoration:none}
.btn:hover{background-color:#2a3038;border-color:#ff6b35}
.btn-secondary{border-color:#a0a4ab;color:#a0a4ab}.btn-secondary:hover{color:#ff6b35;border-color:#ff6b35}
.placeholder{padding:1.5rem;background-color:#0f1419;border-left:3px solid #2a3038;color:#a0a4ab;font-size:.85em;font-style:italic;margin:1rem 0}
.dashboard-footer{background-color:#0f1419;color:#a0a4ab;font-size:.85em;padding:2rem;margin-top:3rem;border-top:1px solid #2a3038}
.footer-content{display:flex;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem}
.footer-credit{font-weight:600;color:#e4e6eb;margin-bottom:.25em}
.footer-scan-id code{font-family:"IBM Plex Mono","Fira Code",monospace;color:#ff6b35;background-color:#1a1f26;padding:.25em .5em;border-radius:2px}
.footer-actions{text-align:center;padding-top:1rem;border-top:1px solid #2a3038}
.req-summary{margin-bottom:1.5rem;color:#a0a4ab;font-size:.9em}
.req-total{font-family:"IBM Plex Mono","Fira Code",monospace}
.dist-stat-row{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;margin-bottom:1.5rem;font-size:.9em}
.dist-stat strong{font-family:"IBM Plex Mono","Fira Code",monospace;color:#e4e6eb}
.dist-stat{color:#a0a4ab}
.conf-badge{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.85em;font-weight:600}
.flag-badge{display:inline-block;font-size:.7em;background:rgba(255,107,53,.2);color:#ff6b35;border:1px solid #ff6b35;border-radius:3px;padding:.1em .4em;font-family:"IBM Plex Mono","Fira Code",monospace;vertical-align:middle;margin-left:.3em}
.pairs-table{margin-top:1.5rem}.pairs-table h3{font-size:1em;margin:0 0 1rem 0}
.score-badge{display:inline-block;padding:.2em .6em;border-radius:3px;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.85em;font-weight:700}
.score-badge.score-high{background:#43a047;color:#fff}.score-badge.score-medium{background:#ff6b35;color:#fff}.score-badge.score-low{background:#607d8b;color:#fff}
.doc-name{font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.85em;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chain-viz{overflow-x:auto;min-height:60px}
.no-data{color:#a0a4ab;font-style:italic;padding:1rem}
.ref-overview-grid{display:grid;grid-template-columns:300px 1fr;gap:1.5rem;align-items:start;margin-bottom:1.5rem}
.ref-resolution-block{background-color:#0f1419;padding:1rem;border-radius:4px;border:1px solid #2a3038}
.ref-breakdown{display:flex;flex-direction:column;gap:.3rem;margin-top:.6rem;font-size:.82em;font-family:"IBM Plex Mono","Fira Code",monospace}
.rb-ok{color:#43a047}.rb-ext{color:#1e88e5}.rb-miss{color:#d32f2f}
.norm-badges-block{background-color:#0f1419;padding:1rem;border-radius:4px;border:1px solid #2a3038}
.norm-badges{display:flex;flex-wrap:wrap;gap:.4rem}
.norm-badge{background-color:#0f1419;border:1px solid #1e88e5;color:#1e88e5;padding:.2em .6em;border-radius:3px;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.78em}
.norm-badge-warn{border-color:#ff6b35;color:#ff6b35}
.missing-refs-block{margin-top:1.25rem;background:rgba(255,107,53,.07);border:1px solid #ff6b35;border-radius:4px;padding:.75rem 1rem}
.failed-files-block{margin-top:1.25rem}
.safety-badge{background-color:rgba(211,47,47,.15);border:1px solid #d32f2f;border-left:4px solid #d32f2f;padding:.75rem 1rem;border-radius:4px;margin-bottom:1.5rem;display:flex;align-items:center;gap:.75rem}
.safety-icon{color:#d32f2f;font-size:1.2em}
.safety-text{color:#d32f2f;font-weight:600;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.9em}
.consistency-summary{background-color:#0f1419;border-left:4px solid #43a047;padding:.75rem 1rem;margin-bottom:1.5rem;border-radius:4px;display:flex;align-items:center;gap:.75rem;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.9em}
.consistency-table{margin-top:0}
.check-desc{font-size:.85em;color:#a0a4ab;font-weight:400;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media(max-width:900px){.ref-overview-grid{grid-template-columns:1fr}.gauge-container{grid-template-columns:1fr}.gauge-chart-wrap{width:100%}}
@media(max-width:640px){.container{padding:1rem}section{padding:1rem}.kpi-cards{grid-template-columns:1fr 1fr}.dashboard-header{flex-direction:column}.header-metrics{justify-content:flex-start}table{font-size:.8em}th,td{padding:.5rem}}
@media(max-width:400px){.kpi-cards{grid-template-columns:1fr}}
.table-search-wrap{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem}
.table-search{background:#0f1419;border:1px solid #2a3038;border-radius:4px;color:#e4e6eb;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.85em;padding:.4em .8em;width:280px;outline:none}
.table-search:focus{border-color:#ff6b35}
.table-search-count{font-size:.8em;color:#a0a4ab;font-family:"IBM Plex Mono","Fira Code",monospace}
.row-hidden{display:none}
.filter-tabs{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1rem;align-items:center}
.filter-tab{background:#0f1419;border:1px solid #2a3038;color:#a0a4ab;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.78em;padding:.3em .85em;border-radius:3px;cursor:pointer;transition:all .12s;text-transform:uppercase;letter-spacing:.5px;line-height:1.4}
.filter-tab:hover{border-color:#ff6b35;color:#ff6b35}
.filter-tab.active{background:#ff6b35;border-color:#ff6b35;color:#fff;font-weight:600}
.doc-link{color:#1e88e5;text-decoration:none;font-family:"IBM Plex Mono","Fira Code",monospace;cursor:pointer}
.doc-link:hover{color:#ff6b35;text-decoration:underline}
.doc-name-cell{display:flex;flex-direction:column;gap:.15rem}
.doc-meta-tag{font-size:.72em;color:#a0a4ab;font-family:"IBM Plex Mono","Fira Code",monospace}
.req-type-badge{display:inline-block;padding:.15em .5em;border-radius:3px;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.78em;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.3px}
.req-table-section{margin-top:2rem}.req-table-section h3{margin-bottom:1rem}
.req-table-controls{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;margin-bottom:.75rem}
.file-tree-section h2{margin-bottom:.5rem}
.tree-toolbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem}
.tree-btn{background:#1a1f26;border:1px solid #2a3038;color:#e4e6eb;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.75em;padding:.3rem .8rem;border-radius:4px;cursor:pointer}
.tree-btn:hover{border-color:#ff6b35;color:#ff6b35}
.file-tree{border:1px solid #2a3038;border-radius:6px;padding:.75rem .75rem .75rem .5rem;background:#0f1419;max-height:70vh;overflow-y:auto;font-family:"IBM Plex Mono","Fira Code",monospace;font-size:.83em;line-height:1}
.tree-children{margin-left:.85rem;padding-left:.9rem;border-left:1px solid #2a3038}
.tree-dir{margin:.05rem 0}
.tree-dir-summary{display:flex;align-items:center;gap:.4rem;padding:.28rem .4rem;border-radius:4px;cursor:pointer;user-select:none;list-style:none;margin-left:-.4rem}
.tree-dir-summary::-webkit-details-marker{display:none}
.tree-arrow{display:inline-block;width:.7em;font-size:.7em;color:#a0a4ab;flex-shrink:0;transition:transform .15s}
.tree-arrow::before{content:'▶'}
details[open]>.tree-dir-summary .tree-arrow{transform:rotate(90deg)}
.tree-dir-summary:hover{background:#1a1f26}
.tree-dir-icon{font-size:.85em;flex-shrink:0}
.tree-dir-name{color:#e4e6eb;font-weight:600;letter-spacing:.01em}
.tree-dir-count{font-size:.72em;color:#a0a4ab;margin-left:auto;padding-right:.2rem;white-space:nowrap}
.tree-file{display:flex;align-items:center;gap:.35rem;padding:.2rem .4rem;border-radius:3px;margin-left:-.4rem}
.tree-file:hover{background:#1a1f26}
.tree-file-icon{font-size:.8em;flex-shrink:0;opacity:.5}
.tree-file a{color:#1e88e5;text-decoration:none}.tree-file a:hover{text-decoration:underline}
.tree-ext-badge{font-size:.62em;font-family:"IBM Plex Mono","Fira Code",monospace;border:1px solid;border-radius:3px;padding:0 4px;flex-shrink:0}
.tree-meta{font-size:.73em;color:#a0a4ab;margin-left:.1em}.tree-meta.mono{font-family:"IBM Plex Mono","Fira Code",monospace}
.tree-doctype{font-size:.68em;color:#a0a4ab;margin-left:.3em;opacity:.7;text-transform:capitalize}
.data-table thead{background-color:#0f1419;border-bottom:2px solid #ff6b35}
.dist-filter-row{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:.4rem}
.dist-filter-label{font-size:.75em;text-transform:uppercase;letter-spacing:1px;color:#a0a4ab;font-family:"IBM Plex Mono","Fira Code",monospace;white-space:nowrap;min-width:70px}
.doc-browser{margin-top:2rem;border-top:1px solid #2a3038;padding-top:1.5rem}
.doc-browser h3{margin-top:0}
@media print{body{background-color:white;color:black}section{background-color:white;border:1px solid #ccc;page-break-inside:avoid}.dashboard-header{background:white;border-left-color:#333}.btn,.table-search-wrap{display:none}}
`;

// ── Section: Header ──────────────────────────────────────────────────────────

function sectionHeader(data: Record<string, unknown>): string {
  const summary = (data.summary as any) ?? {};
  const totalFiles   = summary.totalFiles ?? 0;
  const parsedFiles  = summary.parsedFiles ?? 0;
  const parseRate    = totalFiles > 0 ? ((parsedFiles / totalFiles) * 100).toFixed(0) : "0";
  const versionPairs = (data.versionPairs as any[]) ?? [];
  const highConf     = versionPairs.filter((v: any) => (v.confidence ?? 0) >= 0.8 || (v.score ?? 0) >= 10).length;
  const references   = (data.references as any[]) ?? [];
  const requirements = (data.requirements as any[]) ?? [];
  const checks       = (data.consistencyChecks as any[]) ?? [];
  const passed       = checks.filter((c: any) => c.status === "PASS").length;
  const safetyCrit   = requirements.filter((r: any) => r.safetyCritical).length;

  const scanId = esc(String(data.scanId ?? "unknown"));
  const ts     = data.startedAt ? new Date(data.startedAt as string).toLocaleString() : "";

  return `
<div class="dashboard-header">
  <div class="header-content">
    <div class="header-logo">HUGINN</div>
    <h1 class="header-scan-id">${scanId}</h1>
    <p class="timestamp">Generated ${esc(ts)}</p>
  </div>
  <div class="header-metrics">
    <div class="header-metric">
      <div class="hm-label">Files</div>
      <div class="hm-value" style="color:#43a047">${totalFiles}</div>
      <div class="hm-sub">${parsedFiles} parsed</div>
    </div>
    <div class="header-metric">
      <div class="hm-label">Version Pairs</div>
      <div class="hm-value" style="color:#ff6b35">${versionPairs.length}</div>
      <div class="hm-sub">${highConf} HIGH</div>
    </div>
    <div class="header-metric">
      <div class="hm-label">References</div>
      <div class="hm-value" style="color:#1e88e5">${references.length}</div>
      <div class="hm-sub">&nbsp;</div>
    </div>
    <div class="header-metric">
      <div class="hm-label">Requirements</div>
      <div class="hm-value" style="color:#d32f2f">${requirements.length}</div>
      <div class="hm-sub">${safetyCrit > 0 ? `${safetyCrit} safety-critical` : "&nbsp;"}</div>
    </div>
  </div>
</div>

<section class="kpi-cards">
  <div class="kpi-card" style="--kpi-accent:#43a047">
    <div class="kpi-icon" style="color:#43a047"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h5l3 3v10H4V1zm5 0v3h3"/></svg></div>
    <div class="kpi-label">PARSED</div>
    <div class="kpi-value" style="color:#43a047">${parsedFiles}<span class="kpi-denom">/${totalFiles}</span></div>
    <div class="kpi-sub">${parseRate}% success rate</div>
  </div>
  <div class="kpi-card" style="--kpi-accent:#ff6b35">
    <div class="kpi-icon" style="color:#ff6b35"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 8a5 5 0 0 1 10 0M8 3v5l3 3"/></svg></div>
    <div class="kpi-label">VERSION PAIRS</div>
    <div class="kpi-value" style="color:#ff6b35">${highConf}<span class="kpi-denom">/${versionPairs.length}</span></div>
    <div class="kpi-sub">HIGH confidence</div>
  </div>
  <div class="kpi-card" style="--kpi-accent:#1e88e5">
    <div class="kpi-icon" style="color:#1e88e5"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l4 4-4 4M4 6h8M4 10h5"/></svg></div>
    <div class="kpi-label">REFERENCES</div>
    <div class="kpi-value" style="color:#1e88e5">${references.length}</div>
    <div class="kpi-sub">&nbsp;</div>
  </div>
  <div class="kpi-card" style="--kpi-accent:#d32f2f">
    <div class="kpi-icon" style="color:#d32f2f"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l1 5h5l-4 3 1 5-4-3-4 3 1-5-4-3h5z"/></svg></div>
    <div class="kpi-label">REQUIREMENTS</div>
    <div class="kpi-value" style="color:#d32f2f">${requirements.length}</div>
    <div class="kpi-sub">${safetyCrit > 0 ? `<span style="color:#d32f2f">⚠ ${safetyCrit} safety-critical</span>` : "&nbsp;"}</div>
  </div>
  <div class="kpi-card" style="--kpi-accent:#9c27b0">
    <div class="kpi-icon" style="color:#9c27b0"><svg viewBox="0 0 16 16" fill="currentColor"><polyline points="3,8 6,11 13,4"/></svg></div>
    <div class="kpi-label">QA CHECKS</div>
    <div class="kpi-value" style="color:#9c27b0">${passed}<span class="kpi-denom">/${checks.length}</span></div>
    <div class="kpi-sub">${checks.length - passed} checks failing</div>
  </div>
</section>`;
}

// ── Section: Quality Gauge ───────────────────────────────────────────────────

function sectionQualityGauge(data: Record<string, unknown>): string {
  const mq = (data.metadataQualityScore as any) ?? {};
  const score  = mq.overall ?? 0;
  const interp = esc(mq.interpretation ?? "No data");
  const comps  = (mq.components as any) ?? {};

  const parseRate   = comps.parseSuccessRate ?? 0;
  const headingConf = comps.headingExtractionConfidence ?? 0;
  const reqDelta    = comps.requirementValidationDelta ?? 0;
  const ocrWarn     = comps.ocrWarningRate ?? 0;
  const ocrScore    = 100 - ocrWarn;
  const calibStatus = esc(String(comps.versionPairCalibrationStatus ?? "uncalibrated"));

  const scoreColor = score >= 80 ? "#43a047" : score >= 60 ? "#ff6b35" : "#d32f2f";

  const bar = (pct: number, color: string) =>
    `<div class="mini-bar-wrap"><div class="mini-bar" style="width:${Math.min(100, pct)}%;background:${color}"></div></div>`;

  return `
<section class="quality-gauge">
  <h2>Data Quality Assessment</h2>
  <p class="section-desc">${interp}</p>
  <div class="gauge-container">
    <div class="gauge-chart-wrap">
      <canvas id="mq-gauge-chart" width="220" height="220"></canvas>
      <div class="gauge-center-text">
        <div class="gauge-score" style="color:${scoreColor}">${score}</div>
        <div class="gauge-sub">/100</div>
      </div>
    </div>
    <div class="gauge-components">
      <table class="component-table">
        <thead><tr><th>Component</th><th style="width:120px"></th><th>Score</th></tr></thead>
        <tbody>
          <tr><td>Parse Success Rate</td><td>${bar(parseRate, "#1e88e5")}</td><td style="text-align:right;font-family:monospace;font-weight:600">${parseRate}%</td></tr>
          <tr><td>Heading Extraction</td><td>${bar(headingConf, "#43a047")}</td><td style="text-align:right;font-family:monospace;font-weight:600">${headingConf}%</td></tr>
          <tr><td>Req. Validation Agreement</td><td>${bar(reqDelta, "#ff6b35")}</td><td style="text-align:right;font-family:monospace;font-weight:600">${reqDelta}%</td></tr>
          <tr><td>OCR Coverage</td><td>${bar(ocrScore, "#9c27b0")}</td><td style="text-align:right;font-family:monospace;font-weight:600">${ocrScore}%</td></tr>
        </tbody>
      </table>
      <p class="calibration-note">Version calibration: ${calibStatus}</p>
    </div>
  </div>
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof Chart === 'undefined') return;
  var ctx = document.getElementById('mq-gauge-chart');
  if (ctx) {
    new Chart(ctx, {
      type: 'doughnut',
      data: { datasets: [{ data: [${score}, ${100 - score}], backgroundColor: ['${scoreColor}','#1e2530'], borderWidth: 0 }] },
      options: { cutout: '78%', rotation: -90, circumference: 180, responsive: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
    });
  }
});
</script>`;
}

// ── Section: Document Distribution ──────────────────────────────────────────

function sectionDocDistribution(data: Record<string, unknown>): string {
  const summary = (data.summary as any) ?? {};
  const total    = summary.totalFiles ?? 0;
  const parsed   = summary.parsedFiles ?? 0;
  const failed   = summary.parseFailures ?? 0;
  const scanned  = summary.scannedPdfs ?? 0;
  const ocrReq   = summary.ocrRequired ?? 0;
  const byExt    = (summary.byExtension as Record<string, number>) ?? {};
  const byLang   = (summary.byLanguage as Record<string, number>) ?? {};
  const byType   = (summary.byDocType as Record<string, number>) ?? {};

  const extLabels   = JSON.stringify(Object.keys(byExt));
  const extData     = JSON.stringify(Object.values(byExt));
  const langLabels  = JSON.stringify(Object.keys(byLang));
  const langData    = JSON.stringify(Object.values(byLang));
  const typeLabels  = JSON.stringify(Object.keys(byType));
  const typeData    = JSON.stringify(Object.values(byType));

  const CHART_COLORS = ["#ff6b35","#1e88e5","#43a047","#9c27b0","#00bcd4","#d32f2f","#ff9800","#607d8b","#e91e63","#795548"];

  return `
<section class="document-distribution">
  <h2>Document Distribution &amp; Metadata</h2>
  <div class="dist-stat-row">
    <span class="dist-stat"><strong>${total}</strong> total files</span>
    <span class="dist-stat"><strong>${parsed}</strong> parsed</span>
    <span class="dist-stat"><strong>${failed}</strong> failed</span>
    <span class="dist-stat"><strong>${scanned}</strong> scanned PDFs</span>
    <span class="dist-stat"><strong>${ocrReq}</strong> need OCR</span>
  </div>
  <p class="section-desc" style="margin-top:-.5rem">Click any chart bar to browse documents in that category.</p>
  <div class="distribution-grid">
    <div class="chart-container"><h3>File Types</h3><canvas id="ext-chart"></canvas></div>
    <div class="chart-container"><h3>Languages</h3><canvas id="lang-chart"></canvas></div>
    <div class="chart-container"><h3>Document Types</h3><canvas id="doctype-chart"></canvas></div>
  </div>
  <div class="doc-browser">
    <h3>All Documents</h3>
    <div class="table-search-wrap">
      <input id="dist-search" class="table-search" type="search" placeholder="Search filename, doc type, language…">
      <span id="dist-count" class="table-search-count"></span>
    </div>
    <table id="dist-doc-table">
      <thead>
        <tr>
          <th>Filename</th><th>Ext</th><th style="text-align:right">~Tokens</th>
          <th>Doc Type</th><th>Language</th><th style="text-align:right">Pages</th>
          <th style="text-align:right">Retention</th>
        </tr>
      </thead>
      <tbody id="dist-tbody"><tr><td colspan="7" style="color:#607d8b;font-style:italic;text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var COLORS = ${JSON.stringify(CHART_COLORS)};
  if (typeof Chart !== 'undefined') {
    var baseOpts = { responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: '#a0a4ab' } }, y: { ticks: { color: '#a0a4ab' } } } };
    new Chart(document.getElementById('ext-chart'), { type: 'bar', data: { labels: ${extLabels}, datasets: [{ data: ${extData}, backgroundColor: COLORS, borderWidth: 0 }] }, options: Object.assign({}, baseOpts) });
    new Chart(document.getElementById('lang-chart'), { type: 'bar', data: { labels: ${langLabels}, datasets: [{ data: ${langData}, backgroundColor: COLORS, borderWidth: 0 }] }, options: Object.assign({}, baseOpts) });
    new Chart(document.getElementById('doctype-chart'), { type: 'bar', data: { labels: ${typeLabels}, datasets: [{ data: ${typeData}, backgroundColor: COLORS, borderWidth: 0 }] }, options: Object.assign({}, baseOpts) });
  }

  var _d = window.__huginnData;
  var projMap = {};
  if (_d && _d.tokenProjection) {
    (_d.tokenProjection || []).forEach(function(p) { projMap[p.documentId] = p; });
  }
  var docs = (_d && _d.parsed) || [];
  var tbody = document.getElementById('dist-tbody');
  if (!tbody) return;
  if (docs.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="color:#607d8b;font-style:italic;text-align:center">No documents</td></tr>'; return; }

  function renderRows(rows) {
    tbody.innerHTML = rows.map(function(d) {
      var proj = projMap[d.id];
      var ret = proj ? (proj.tokenRetentionRate * 100).toFixed(0) + '%' : '—';
      var retColor = proj ? (proj.tokenRetentionRate < 0.4 ? '#e53935' : proj.tokenRetentionRate < 0.6 ? '#ff9800' : '#43a047') : '#a0a4ab';
      return '<tr data-ext="' + (d.extension || '') + '" data-type="' + (d.detectedDocType || '') + '">' +
        '<td style="font-family:monospace;font-size:.82em">' + (d.filename || '').replace(/</g,'&lt;') + '</td>' +
        '<td>' + (d.extension || '') + '</td>' +
        '<td style="text-align:right">' + (d.tokenCountEstimate || 0).toLocaleString() + '</td>' +
        '<td>' + (d.detectedDocType || '—') + '</td>' +
        '<td>' + (d.language || '—') + '</td>' +
        '<td style="text-align:right">' + (d.pageCount || '—') + '</td>' +
        '<td style="text-align:right;color:' + retColor + '">' + ret + '</td>' +
        '</tr>';
    }).join('');
    document.getElementById('dist-count').textContent = rows.length + ' / ' + docs.length;
  }
  renderRows(docs);

  document.getElementById('dist-search').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    var filtered = docs.filter(function(d) {
      return (d.filename||'').toLowerCase().includes(q) ||
             (d.detectedDocType||'').toLowerCase().includes(q) ||
             (d.language||'').toLowerCase().includes(q);
    });
    renderRows(filtered);
  });
});
</script>`;
}

// ── Section: File Tree ───────────────────────────────────────────────────────

function sectionFileTree(data: Record<string, unknown>): string {
  const parsed = (data.parsed as any[]) ?? [];
  const totalHeadings = parsed.reduce((s: number, d: any) => s + (d.headingCount ?? d.headings?.length ?? 0), 0);
  const withHeadings  = parsed.filter((d: any) => (d.headingCount ?? d.headings?.length ?? 0) > 0).length;

  return `
<section class="file-tree-section">
  <h2>Document Base Tree &amp; Heading Analysis</h2>
  <p class="section-desc">${parsed.length} files &bull; ${withHeadings} with headings &bull; ${totalHeadings.toLocaleString()} total headings extracted</p>
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
  var _d = window.__huginnData;
  var files = (_d && _d.files) || [];
  var root = document.getElementById('file-tree-root');
  if (!root || files.length === 0) { if(root) root.innerHTML = '<p class="no-data">No files</p>'; return; }

  // Build tree from file paths
  var tree = {};
  files.forEach(function(f) {
    var parts = (f.path || f.filename || '').replace(/\\\\/g,'/').split('/');
    var node = tree;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = { __files: [], __dirs: {} };
      node = node[parts[i]].__dirs || (node[parts[i]].__dirs = {});
    }
    // leaf
    var dir = node;
    if (parts.length > 1) {
      var parent = tree;
      for (var j = 0; j < parts.length - 1; j++) { parent = parent[parts[j]] ? parent[parts[j]] : parent; }
    }
  });

  function renderTree(files) {
    var dirs = {};
    files.forEach(function(f) {
      var parts = (f.path || f.filename || '').replace(/\\\\/g, '/').split('/');
      var key = parts.length > 1 ? parts.slice(0, -1).join('/') : '__root__';
      if (!dirs[key]) dirs[key] = [];
      dirs[key].push(f);
    });

    function renderDir(key, depth) {
      var items = dirs[key] || [];
      var html = '';
      var subdirs = {};
      items.forEach(function(f) {
        var parts = (f.path || f.filename || '').replace(/\\\\/g, '/').split('/');
        if (parts.length > depth + 1) {
          var dk = parts.slice(0, depth + 1).join('/');
          if (!subdirs[dk]) subdirs[dk] = true;
        }
      });
      Object.keys(subdirs).forEach(function(dk) {
        var dname = dk.split('/').pop();
        var count = files.filter(function(f) { return (f.path||'').startsWith(dk + '/') || (f.path||'') === dk; }).length;
        html += '<details class="tree-dir"><summary class="tree-dir-summary"><span class="tree-arrow"></span><span class="tree-dir-icon">📁</span><span class="tree-dir-name">' + dname + '</span><span class="tree-dir-count">' + count + ' files</span></summary><div class="tree-children">' + renderDir(dk, depth + 1) + '</div></details>';
      });
      files.filter(function(f) {
        var parts = (f.path || f.filename || '').replace(/\\\\/g, '/').split('/');
        var fkey = parts.length > 1 ? parts.slice(0, -1).join('/') : '__root__';
        return fkey === key;
      }).forEach(function(f) {
        var extColors = { '.pdf': '#d32f2f', '.xlsx': '#43a047', '.docx': '#1e88e5', '.pptx': '#ff9800' };
        var ext = f.extension || '';
        var extColor = extColors[ext] || '#607d8b';
        html += '<div class="tree-file"><span class="tree-file-icon">📄</span><span class="tree-ext-badge" style="color:' + extColor + ';border-color:' + extColor + '">' + ext + '</span><span style="font-size:.82em;color:#e4e6eb">' + (f.filename || '').replace(/</g,'&lt;') + '</span></div>';
      });
      return html;
    }

    root.innerHTML = renderDir('__root__', 0) || files.map(function(f) {
      return '<div class="tree-file"><span class="tree-file-icon">📄</span><span style="font-size:.82em;color:#e4e6eb">' + (f.filename || '').replace(/</g,'&lt;') + '</span></div>';
    }).join('');
  }

  renderTree(files);

  document.getElementById('tree-expand-all').onclick = function() { root.querySelectorAll('details').forEach(function(d) { d.open = true; }); };
  document.getElementById('tree-collapse-all').onclick = function() { root.querySelectorAll('details').forEach(function(d) { d.open = false; }); };

  document.getElementById('tree-search').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    var filtered = q ? files.filter(function(f) { return (f.path||f.filename||'').toLowerCase().includes(q); }) : files;
    document.getElementById('tree-match-count').textContent = q ? filtered.length + ' matches' : '';
    renderTree(filtered);
  });
});
</script>`;
}

// ── Section: Version Pairs ───────────────────────────────────────────────────

function sectionVersionPairs(data: Record<string, unknown>): string {
  const pairs    = (data.versionPairs as any[]) ?? [];
  const chains   = (data.versionChains as any[]) ?? [];
  const hist     = (data.versionPairScoreHistogram as Record<string, number>) ?? {};
  const histLabels = JSON.stringify(Object.keys(hist));
  const histData   = JSON.stringify(Object.values(hist));
  const highConf   = pairs.filter((p: any) => (p.confidence ?? 0) >= 0.8 || (p.score ?? 0) >= 10).length;
  const medConf    = pairs.filter((p: any) => {
    const c = p.confidence ?? 0; const s = p.score ?? 0;
    return (c >= 0.5 && c < 0.8) || (s >= 5 && s < 10);
  }).length;

  return `
<section class="version-analysis">
  <h2>Version Pairs &amp; Clustering</h2>
  <p class="section-desc">${pairs.length} total pairs &bull; ${highConf} HIGH &bull; ${medConf} MEDIUM &bull; ${chains.length} chains detected</p>
  <div class="distribution-grid">
    <div class="chart-container">
      <h3>Score Histogram</h3>
      <canvas id="version-histogram-chart"></canvas>
    </div>
  </div>
  <div class="pairs-table">
    <h3>Version Pairs (top 100)</h3>
    <div class="table-search-wrap">
      <input id="pairs-search" class="table-search" type="search" placeholder="Filter by document ID…">
      <span id="pairs-count" class="table-search-count"></span>
    </div>
    <table id="pairs-table-data">
      <thead><tr><th>Older Doc</th><th>Newer Doc</th><th>Score / Confidence</th><th>Method</th></tr></thead>
      <tbody id="pairs-tbody"><tr><td colspan="4" style="color:#607d8b;font-style:italic;text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof Chart !== 'undefined') {
    new Chart(document.getElementById('version-histogram-chart'), {
      type: 'bar',
      data: { labels: ${histLabels}, datasets: [{ data: ${histData}, backgroundColor: '#ff6b35', borderWidth: 0 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#a0a4ab' } }, y: { beginAtZero: true, ticks: { color: '#a0a4ab' } } } }
    });
  }

  var _d = window.__huginnData;
  var pairs = (_d && _d.versionPairs) || [];
  var tbody = document.getElementById('pairs-tbody');
  var countEl = document.getElementById('pairs-count');
  if (!tbody) return;

  function renderPairs(rows) {
    var shown = rows.slice(0, 100);
    tbody.innerHTML = shown.map(function(p) {
      var conf = p.confidence != null ? (p.confidence * 100).toFixed(0) + '%' : (p.score != null ? 'score ' + p.score : '—');
      var confColor = (p.confidence >= 0.8 || p.score >= 10) ? '#43a047' : (p.confidence >= 0.5 || p.score >= 5) ? '#ff9800' : '#607d8b';
      return '<tr>' +
        '<td style="font-family:monospace;font-size:.82em">' + (p.olderDocumentId || p.docAId || '').replace(/</g,'&lt;') + '</td>' +
        '<td style="font-family:monospace;font-size:.82em">' + (p.newerDocumentId || p.docBId || '').replace(/</g,'&lt;') + '</td>' +
        '<td style="color:' + confColor + ';font-family:monospace">' + conf + '</td>' +
        '<td>' + (p.method || '—') + '</td></tr>';
    }).join('');
    countEl.textContent = rows.length + ' pairs';
  }
  renderPairs(pairs);

  document.getElementById('pairs-search').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    renderPairs(q ? pairs.filter(function(p) {
      return (p.olderDocumentId||p.docAId||'').toLowerCase().includes(q) ||
             (p.newerDocumentId||p.docBId||'').toLowerCase().includes(q);
    }) : pairs);
  });
});
</script>`;
}

// ── Section: Requirements ────────────────────────────────────────────────────

function sectionRequirements(data: Record<string, unknown>): string {
  const reqs      = (data.requirements as any[]) ?? [];
  const safety    = reqs.filter((r: any) => r.safetyCritical).length;
  const byType    = reqs.reduce((acc: Record<string, number>, r: any) => { acc[r.type || "other"] = (acc[r.type || "other"] ?? 0) + 1; return acc; }, {});
  const typeLabels = JSON.stringify(Object.keys(byType));
  const typeData   = JSON.stringify(Object.values(byType));
  const COLORS     = ["#d32f2f","#1e88e5","#ff6b35","#43a047","#9c27b0","#ff9800","#607d8b"];

  return `
<section class="requirements-landscape">
  <h2>Requirements Landscape</h2>
  ${safety > 0 ? `<div class="safety-badge"><span class="safety-icon">⚠</span><span>${safety} requirements flagged safety-critical — manual review required</span></div>` : ""}
  <p class="section-desc">${reqs.length} requirements extracted</p>
  <div class="distribution-grid">
    <div class="chart-container"><h3>By Type</h3><canvas id="req-type-chart"></canvas></div>
  </div>
  <div class="req-table-section">
    <h3>All Requirements (first 500)</h3>
    <div class="req-table-controls">
      <div class="filter-tabs" style="margin-bottom:0">
        <button class="filter-tab active" data-req-filter="ALL">ALL <span style="opacity:.7">(${reqs.length})</span></button>
        ${safety > 0 ? `<button class="filter-tab" id="req-safety-toggle">⚠ Safety only</button>` : ""}
      </div>
    </div>
    <div class="table-search-wrap" style="margin-top:.75rem">
      <input id="req-search" class="table-search" type="search" placeholder="Search section heading, doc, category…">
      <span id="req-visible-count" class="table-search-count"></span>
    </div>
    <table id="req-table">
      <thead><tr><th>Type</th><th>Category</th><th style="text-align:center">Safety</th><th>Source Doc</th><th>Section</th></tr></thead>
      <tbody id="req-tbody"><tr><td colspan="5" style="color:#607d8b;font-style:italic;text-align:center">Loading…</td></tr></tbody>
    </table>
  </div>
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof Chart !== 'undefined') {
    new Chart(document.getElementById('req-type-chart'), {
      type: 'bar',
      data: { labels: ${typeLabels}, datasets: [{ data: ${typeData}, backgroundColor: ${JSON.stringify(COLORS)}, borderWidth: 0 }] },
      options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: '#a0a4ab' } }, y: { grid: { display: false }, ticks: { color: '#a0a4ab' } } } }
    });
  }

  var _d = window.__huginnData;
  var allReqs = (_d && _d.requirements) || [];
  var LIMIT = 500;
  var tbody = document.getElementById('req-tbody');
  var countEl = document.getElementById('req-visible-count');
  var safetyOnly = false;
  var searchQ = '';

  function getVisible() {
    var rows = allReqs;
    if (safetyOnly) rows = rows.filter(function(r) { return r.safetyCritical; });
    if (searchQ) rows = rows.filter(function(r) {
      return (r.headingContext||'').toLowerCase().includes(searchQ) ||
             (r.type||'').toLowerCase().includes(searchQ) ||
             (r.category||'').toLowerCase().includes(searchQ) ||
             (r.docId||'').toLowerCase().includes(searchQ);
    });
    return rows;
  }

  function TYPE_COLOR(t) { return { MANDATORY: '#d32f2f', RECOMMENDED: '#ff6b35', PERMITTED: '#1e88e5', DECLARATIVE: '#43a047' }[t] || '#607d8b'; }

  function renderReqs() {
    var rows = getVisible();
    var shown = rows.slice(0, LIMIT);
    tbody.innerHTML = shown.map(function(r) {
      return '<tr>' +
        '<td><span class="req-type-badge" style="background:' + TYPE_COLOR(r.type) + '">' + (r.type||'?') + '</span></td>' +
        '<td>' + (r.category||'—') + '</td>' +
        '<td style="text-align:center">' + (r.safetyCritical ? '⚠' : '') + '</td>' +
        '<td style="font-family:monospace;font-size:.78em">' + (r.docId||'—').replace(/</g,'&lt;') + '</td>' +
        '<td style="font-size:.82em">' + (r.headingContext||'').replace(/</g,'&lt;').slice(0,80) + '</td>' +
        '</tr>';
    }).join('');
    countEl.textContent = rows.length + (rows.length > LIMIT ? ' (showing ' + LIMIT + ')' : '') + ' / ' + allReqs.length;
  }
  renderReqs();

  var st = document.getElementById('req-safety-toggle');
  if (st) st.onclick = function() { safetyOnly = !safetyOnly; this.classList.toggle('active', safetyOnly); renderReqs(); };
  document.getElementById('req-search').addEventListener('input', function() { searchQ = this.value.toLowerCase(); renderReqs(); });
});
</script>`;
}

// ── Section: References ──────────────────────────────────────────────────────

function sectionReferences(data: Record<string, unknown>): string {
  const refs     = (data.references as any[]) ?? [];
  const resolved = refs.filter((r: any) => r.resolution === "resolved" || r.resolved).length;
  const external = refs.filter((r: any) => r.resolution === "external_norm" || r.type === "norm").length;
  const missing  = refs.filter((r: any) => r.resolution === "unresolved" || (!r.resolved && r.type !== "norm")).length;

  const normCounts: Record<string, number> = {};
  refs.forEach((r: any) => {
    if (r.type === "norm" || r.resolution === "external_norm") {
      const body = (r.raw || r.normId || "").match(/^([A-Z]+)/)?.[1] ?? "OTHER";
      normCounts[body] = (normCounts[body] ?? 0) + 1;
    }
  });
  const topNorms = Object.entries(normCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const normLabels = JSON.stringify(topNorms.map(([k]) => k));
  const normData   = JSON.stringify(topNorms.map(([, v]) => v));

  const rateColor = resolved / Math.max(refs.length, 1) > 0.6 ? "#43a047" : "#ff9800";

  return `
<section class="reference-graph">
  <h2>References &amp; Graph Resolution</h2>
  <p class="section-desc">${refs.length} total &bull; ${external} norms &bull; ${resolved} resolved &bull; ${missing} unresolved</p>
  <div class="ref-overview-grid">
    <div class="ref-resolution-block">
      <div class="metric-label">Resolution Rate</div>
      <div class="metric-gauge"><div class="gauge-bar" style="width:${Math.min(100, refs.length > 0 ? (resolved / refs.length * 100) : 0).toFixed(1)}%;background:${rateColor}"></div></div>
      <div class="metric-value" style="color:${rateColor}">${refs.length > 0 ? (resolved / refs.length * 100).toFixed(1) : 0}%</div>
      <div class="ref-breakdown">
        <span class="rb-item rb-ok">✓ ${resolved} exact/fuzzy</span>
        <span class="rb-item rb-ext">⊞ ${external} external norm</span>
        <span class="rb-item rb-miss">✗ ${missing} unresolved</span>
      </div>
    </div>
    ${topNorms.length > 0 ? `
    <div class="norm-badges-block">
      <div class="metric-label" style="margin-bottom:.75rem">Detected Norm Bodies</div>
      <div class="norm-badges">${topNorms.map(([k]) => `<span class="norm-badge">${esc(k)}</span>`).join("")}</div>
    </div>` : ""}
  </div>
  ${topNorms.length > 0 ? `
  <div class="chart-container" style="max-width:480px;margin-top:1.5rem">
    <h3>By Standard Body</h3>
    <canvas id="norm-family-chart"></canvas>
  </div>` : ""}
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof Chart === 'undefined') return;
  var famCtx = document.getElementById('norm-family-chart');
  if (famCtx) {
    new Chart(famCtx, {
      type: 'bar',
      data: { labels: ${normLabels}, datasets: [{ data: ${normData}, backgroundColor: '#1e88e5', borderWidth: 0 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: '#a0a4ab' } }, x: { grid: { display: false }, ticks: { color: '#a0a4ab' } } } }
    });
  }
});
</script>`;
}

// ── Section: Parse Health ────────────────────────────────────────────────────

function sectionParseHealth(data: Record<string, unknown>): string {
  const summary     = (data.summary as any) ?? {};
  const parseHealth = (data.parseHealth as any) ?? {};
  const total    = summary.totalFiles ?? 0;
  const parsed   = summary.parsedFiles ?? 0;
  const scanned  = summary.scannedPdfs ?? 0;
  const ocrReq   = summary.ocrRequired ?? 0;
  const failedFiles = (parseHealth.failedFiles as any[]) ?? [];

  const successRate = total > 0 ? (parsed / total * 100).toFixed(1) : "0.0";
  const ocrPct      = total > 0 ? (ocrReq / total * 100).toFixed(1) : "0.0";
  const scannedPct  = total > 0 ? (scanned / total * 100).toFixed(1) : "0.0";

  const corpusSummary = (data.corpusTokenSummary as any) ?? null;
  const ocrNote = corpusSummary && corpusSummary.totalTokensRaw > 0
    ? ` <span style="color:#ff9800;font-size:.82em">(OCR docs contribute ~${Math.round(ocrReq / Math.max(total, 1) * 100)}% of files)</span>`
    : "";

  const failedRows = failedFiles.map((f: any) => `
    <tr>
      <td style="font-family:monospace;font-size:.82em">${esc(String(f.path ?? f.filename ?? f.id ?? "unknown").split("/").pop() ?? "")}</td>
      <td style="color:#d32f2f;font-size:.85em">${esc(String(f.reason ?? "unknown"))}</td>
    </tr>`).join("");

  return `
<section class="parse-health">
  <h2>Parse Health &amp; OCR Status</h2>
  <p class="section-desc">${parsed} parsed &bull; ${failedFiles.length} failed &bull; ${scanned} scanned PDFs &bull; ${ocrReq} need OCR${ocrNote}</p>
  <div class="parse-health-metrics">
    <div class="parse-metric">
      <div class="metric-label">Parse Success Rate</div>
      <div class="metric-gauge"><div class="gauge-bar" style="width:${successRate}%;background:#43a047"></div></div>
      <div class="metric-value" style="color:#43a047">${successRate}%</div>
    </div>
    <div class="parse-metric">
      <div class="metric-label">OCR Required</div>
      <div class="metric-gauge"><div class="gauge-bar" style="width:${ocrPct}%;background:#ff9800"></div></div>
      <div class="metric-value" style="color:#ff9800">${ocrReq}<span style="font-size:.75em;font-weight:400;margin-left:.3em">/ ${total} files</span></div>
    </div>
    <div class="parse-metric">
      <div class="metric-label">Scanned PDFs</div>
      <div class="metric-gauge"><div class="gauge-bar" style="width:${scannedPct}%;background:#607d8b"></div></div>
      <div class="metric-value" style="color:#607d8b">${scanned}<span style="font-size:.75em;font-weight:400;margin-left:.3em">of ${total}</span></div>
    </div>
  </div>
  ${failedFiles.length > 0 ? `
  <div class="failed-files-block">
    <h3>Parse Failures</h3>
    <table>
      <thead><tr><th>File</th><th>Reason</th></tr></thead>
      <tbody>${failedRows}</tbody>
    </table>
  </div>` : ""}
</section>`;
}

// ── Section: Consistency Checks ──────────────────────────────────────────────

function sectionConsistencyChecks(data: Record<string, unknown>): string {
  const checks  = (data.consistencyChecks as any[]) ?? [];
  const passed  = checks.filter((c: any) => c.status === "PASS").length;
  const failing = checks.length - passed;
  const color   = failing === 0 ? "#43a047" : failing > checks.length / 2 ? "#d32f2f" : "#ff6b35";

  const rows = checks.map((c: any) => {
    const s = String(c.status ?? "");
    const badgeBg = s === "PASS" ? "#43a047" : s === "CRITICAL" ? "#d32f2f" : s === "WARNING" ? "#ff6b35" : "#1e88e5";
    return `
    <tr>
      <td><strong>${esc(String(c.name ?? ""))}</strong><br><span class="check-desc">${esc(String(c.description ?? ""))}</span></td>
      <td style="font-family:monospace;text-align:right;white-space:nowrap">${esc(String(c.value ?? ""))}</td>
      <td style="text-align:right;color:#a0a4ab">${esc(String(c.threshold ?? ""))}</td>
      <td style="text-align:center"><span class="badge" style="background:${badgeBg};color:#fff">${esc(s)}</span></td>
    </tr>`;
  }).join("");

  return `
<section class="rag-decisions">
  <h2>Consistency Checks</h2>
  <div class="consistency-summary" style="border-left-color:${color}">
    <span style="color:${color}">${failing === 0 ? "✓" : "⚠"}</span>
    <span class="summary-text">${failing === 0 ? "All checks passing" : `${failing} check${failing !== 1 ? "s" : ""} failing — ${passed}/${checks.length} passed`}</span>
  </div>
  <div class="table-search-wrap">
    <input class="table-search" id="check-search" type="search" placeholder="Filter checks…">
    <span class="table-search-count" id="check-count"></span>
  </div>
  <table id="consistency-table-data" class="consistency-table">
    <thead><tr><th>Check</th><th style="text-align:right">Value</th><th style="text-align:right">Threshold</th><th style="text-align:center">Status</th></tr></thead>
    <tbody id="check-tbody">${rows}</tbody>
  </table>
</section>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var tbody = document.getElementById('check-tbody');
  var countEl = document.getElementById('check-count');
  var rows = Array.from(tbody.querySelectorAll('tr'));
  countEl.textContent = rows.length + ' checks';
  document.getElementById('check-search').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    var shown = 0;
    rows.forEach(function(r) {
      var match = !q || r.textContent.toLowerCase().includes(q);
      r.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    countEl.textContent = shown + ' / ' + rows.length + ' checks';
  });
});
</script>`;
}

// ── Section: Muninn Config Recommendations (Task 11) ────────────────────────

function sectionMuninnConfig(data: Record<string, unknown>): string {
  const recs = (data.muninnConfig as any[]) ?? [];
  if (recs.length === 0) return "";

  const CONF_COLOUR: Record<string, string> = {
    HIGH: "#43a047", MEDIUM: "#ff9800", LOW: "#607d8b",
  };

  const cards = recs.map((r: any) => `
    <div class="config-card">
      <div class="config-card-header">
        <span class="config-param">${esc(r.parameter)}</span>
        <span class="config-badge" style="color:${CONF_COLOUR[r.confidence] ?? "#607d8b"}">${esc(r.confidence)}</span>
      </div>
      <div class="config-value">
        <span class="config-old">${esc(String(r.currentDefault))}</span>
        <span class="config-arrow">→</span>
        <span class="config-new">${esc(String(r.recommendedValue))}</span>
        <button class="copy-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(String(r.recommendedValue))})">copy</button>
      </div>
      <div class="config-reasoning">${esc(r.reasoning)}</div>
      <div class="config-meta">${r.evidenceDocCount} doc(s) · ${(r.affectedTokenShare * 100).toFixed(1)}% of corpus tokens affected</div>
    </div>`).join("");

  const envDiff = recs
    .filter((r: any) => r.parameter !== "BOILERPLATE_PATTERNS")
    .map((r: any) => `# ${r.parameter}\n- ${r.parameter}=${r.currentDefault}\n+ ${r.parameter}=${r.recommendedValue}`)
    .join("\n");

  return `
<section id="muninn-config">
  <h2>Muninn Config Recommendations</h2>
  <p class="section-desc">Based on corpus analysis — copy values directly into Muninn .env before ingestion.</p>
  <div class="config-cards">${cards}</div>
  <div style="margin-top:1rem">
    <button class="tree-btn" onclick="navigator.clipboard.writeText(document.getElementById('env-diff').textContent)">Copy .env diff</button>
    <pre id="env-diff" style="margin-top:.5rem;background:#0f1419;padding:1rem;border-radius:4px;font-size:.8em;color:#a0a4ab;white-space:pre-wrap">${esc(envDiff)}</pre>
  </div>
</section>

<style>
.config-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
.config-card{background:#1a1f26;border:1px solid #2a3038;border-radius:4px;padding:1.25rem;display:flex;flex-direction:column;gap:.4rem}
.config-card-header{display:flex;justify-content:space-between;align-items:center}
.config-param{font-family:"IBM Plex Mono","Fira Code",monospace;font-weight:700;font-size:.9em}
.config-badge{font-size:.7em;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.config-value{display:flex;align-items:center;gap:.5rem;font-family:"IBM Plex Mono","Fira Code",monospace}
.config-old{color:#607d8b;text-decoration:line-through}
.config-arrow{color:#a0a4ab}
.config-new{color:#ff6b35;font-weight:700}
.copy-btn{background:#2a3038;border:none;color:#a0a4ab;padding:.2rem .5rem;border-radius:3px;cursor:pointer;font-size:.7em}
.copy-btn:hover{background:#ff6b35;color:#fff}
.config-reasoning{font-size:.8em;color:#a0a4ab;line-height:1.5}
.config-meta{font-size:.72em;color:#607d8b}
</style>`;
}

// ── Section: Ingestion Intelligence (Task 12) ────────────────────────────────

function sectionIngestionIntelligence(data: Record<string, unknown>): string {
  const summary = (data.corpusTokenSummary as any) ?? null;
  if (!summary || summary.totalTokensRaw === 0) return "";

  const waterfall = (summary.lossWaterfall as any[]) ?? [];
  const byDocType = (summary.byDocType as Record<string, any>) ?? {};
  const highRisk  = (summary.highRiskDocs as any[]) ?? [];

  const waterfallStages = ["raw", "afterNormalization", "afterCleaning", "afterChunking", "afterFilter", "embeddable"];
  const STAGE_LABELS    = ["Raw", "After Normalisation", "After Cleaning", "After Chunking", "After Filter", "Embeddable"];
  const STAGE_COLOURS   = ["#607d8b", "#78909c", "#ff9800", "#f57c00", "#e53935", "#43a047"];

  const projections  = (data.tokenProjection as any[]) ?? [];
  const stageValues  = waterfallStages.map((k) =>
    projections.reduce((s: number, p: any) => s + (p.tokenWaterfall?.[k] ?? 0), 0)
  );

  const docTypeLabels  = Object.keys(byDocType);
  const retentionData  = docTypeLabels.map((k) => (byDocType[k].retentionRate * 100).toFixed(1));
  const retentionColours = docTypeLabels.map((k) =>
    byDocType[k].retentionRate < 0.4 ? "#e53935" : byDocType[k].retentionRate < 0.6 ? "#ff9800" : "#43a047"
  );

  const highRiskRows = highRisk.slice(0, 10).map((d: any) => {
    const parsed = ((data.parsed as any[]) ?? []).find((p: any) => p.id === d.docId);
    return `<tr>
      <td style="font-family:monospace;font-size:.78em">${esc(parsed?.filename ?? d.docId ?? "")}</td>
      <td style="color:${d.retentionRate < 0.4 ? "#e53935" : "#ff9800"}">${(d.retentionRate * 100).toFixed(0)}%</td>
      <td>${esc(d.primaryLossCause ?? "")}</td>
    </tr>`;
  }).join("");

  return `
<section id="ingestion-intelligence">
  <h2>Ingestion Intelligence</h2>
  <p class="section-desc">Predicted token flow through Muninn's ingestion pipeline — no documents were ingested; values are simulated from corpus structure.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">
    <div>
      <h3>Token Waterfall</h3>
      <canvas id="waterfall-chart" height="120"></canvas>
    </div>
    <div>
      <h3>Retention by Doc Type</h3>
      <canvas id="retention-chart" height="120"></canvas>
    </div>
  </div>
  ${highRisk.length > 0 ? `
  <h3>High-Risk Documents (retention &lt; 50%)</h3>
  <table class="data-table">
    <thead><tr><th>Filename</th><th>Retention</th><th>Primary Loss Cause</th></tr></thead>
    <tbody>${highRiskRows}</tbody>
  </table>` : ""}
</section>
<script>
(function() {
  var stageValues  = ${JSON.stringify(stageValues)};
  var stageLabels  = ${JSON.stringify(STAGE_LABELS)};
  var stageColours = ${JSON.stringify(STAGE_COLOURS)};

  document.addEventListener('DOMContentLoaded', function() {
    if (typeof Chart === 'undefined') return;
    new Chart(document.getElementById('waterfall-chart'), {
      type: 'bar',
      data: { labels: stageLabels, datasets: [{ data: stageValues, backgroundColor: stageColours }] },
      options: {
        indexAxis: 'y', plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#a0a4ab' } }, y: { ticks: { color: '#a0a4ab' } } }
      }
    });

    var dtLabels  = ${JSON.stringify(docTypeLabels)};
    var dtValues  = ${JSON.stringify(retentionData)};
    var dtColours = ${JSON.stringify(retentionColours)};
    new Chart(document.getElementById('retention-chart'), {
      type: 'bar',
      data: { labels: dtLabels, datasets: [{ label: 'Retention %', data: dtValues, backgroundColor: dtColours }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 0, max: 100, ticks: { color: '#a0a4ab', callback: function(v) { return v + '%'; } } },
          x: { ticks: { color: '#a0a4ab' } }
        }
      }
    });
  });
})();
</script>`;
}

// ── Section: Boilerplate Discovery (Task 13) ─────────────────────────────────

function sectionBoilerplateDiscovery(data: Record<string, unknown>): string {
  const discovery = (data.boilerplateDiscovery as any) ?? null;
  if (!discovery) return "";

  const patterns = ((discovery.patterns as any[]) ?? []).filter((p: any) => !p.alreadyCovered);
  if (patterns.length === 0) {
    return `
<section id="boilerplate-discovery">
  <h2>Boilerplate Discovery</h2>
  <p class="section-desc">No new client-specific boilerplate patterns detected beyond Muninn's existing set.</p>
</section>`;
  }

  const rows = patterns.slice(0, 50).map((p: any) => `
    <tr>
      <td style="font-family:monospace;font-size:.78em;word-break:break-all">${esc(p.normalizedForm)}</td>
      <td>${p.documentCount}</td>
      <td>${p.occurrenceCount}</td>
      <td>${p.tokensAtRisk}</td>
      <td><span style="color:#43a047;font-size:.75em">NEW</span></td>
      <td style="font-family:monospace;font-size:.72em;color:#ff6b35">
        ${esc(p.suggestedRegex)}
        <button class="copy-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(p.suggestedRegex)})">copy</button>
      </td>
    </tr>`).join("");

  const allNewRegexes = patterns.map((p: any) => `  ${p.suggestedRegex},`).join("\n");

  return `
<section id="boilerplate-discovery">
  <h2>Boilerplate Discovery</h2>
  <p class="section-desc">${patterns.length} new pattern(s) found — add to Muninn's <code>cleaner.ts</code> BOILERPLATE_PATTERNS array.</p>
  <button class="tree-btn" style="margin-bottom:1rem" onclick="navigator.clipboard.writeText(document.getElementById('bp-patterns').textContent)">Copy all new patterns</button>
  <pre id="bp-patterns" style="background:#0f1419;padding:1rem;border-radius:4px;font-size:.78em;color:#ff6b35;margin-bottom:1rem;white-space:pre-wrap">// Add to cleaner.ts BOILERPLATE_PATTERNS:\n${esc(allNewRegexes)}</pre>
  <table class="data-table" style="font-size:.82em">
    <thead>
      <tr>
        <th>Normalised Form</th><th>Docs</th><th>Occurrences</th><th>Tokens at Risk</th><th>Status</th><th>Suggested Regex</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

main();
