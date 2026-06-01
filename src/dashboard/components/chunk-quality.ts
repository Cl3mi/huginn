import type { ReportData } from '../lib/report-types.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return n.toFixed(2);
}

function colorForScore(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return '#555';
  if (score >= 0.7) return '#43a047';
  if (score >= 0.4) return '#ff6b35';
  return '#d32f2f';
}

type Tier1 = NonNullable<ReportData['chunkQuality']>['perDoc'][number]['tier1'];
type Tier2 = NonNullable<ReportData['chunkQuality']>['perDoc'][number]['tier2'];

function metricRow(label: string, mean: number | null, p10: number | null, hint: string): string {
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td style="color:${colorForScore(mean)};font-weight:600;">${fmt(mean)}</td>
    <td style="color:${colorForScore(p10)};">${fmt(p10)}</td>
    <td class="metric-hint">${escapeHtml(hint)}</td>
  </tr>`;
}

const TIER1_HINTS: Record<keyof Tier1, string> = {
  sizeFit:                 'Chunks within target token range (700–1100). Low = too short or too long.',
  sentenceBoundaryQuality: 'Cuts land on sentence boundaries. Low = mid-sentence splits.',
  crossReferenceCut:       'References (see §X, ISO Y) kept with their referent. Low = orphaned refs.',
  tableCut:                'Tables kept intact across chunks. Low = tables split across chunks.',
  headerPollution:         'Header/footer text not bleeding into chunks. Low = boilerplate noise.',
  contentScore:            'Information density of chunk text. Low = whitespace, TOC, or fragments.',
};

const TIER2_HINTS = {
  coherenceDrop:      'Embedding similarity drop at chunk boundaries. High = boundaries align with topic shifts.',
  intraChunkCohesion: 'Sentence-to-sentence similarity within a chunk. Low = chunk mixes unrelated topics.',
  centroidDistance:   'Each chunk distinct from doc centroid. Low = chunks too similar / redundant.',
} as const;

function renderMetricProfile(tier1: Tier1, tier2: Tier2): string {
  const t1Rows = (Object.keys(TIER1_HINTS) as Array<keyof Tier1>)
    .map(k => metricRow(k, tier1[k].mean, tier1[k].p10, TIER1_HINTS[k]))
    .join('');

  const t2Rows = tier2
    ? [
        metricRow('coherenceDrop',      tier2.coherenceDrop?.mean      ?? null, tier2.coherenceDrop?.p10      ?? null, TIER2_HINTS.coherenceDrop),
        metricRow('intraChunkCohesion', tier2.intraChunkCohesion?.mean ?? null, tier2.intraChunkCohesion?.p10 ?? null, TIER2_HINTS.intraChunkCohesion),
        metricRow('centroidDistance',   tier2.centroidDistance.mean,            tier2.centroidDistance.p10,            TIER2_HINTS.centroidDistance),
      ].join('')
    : `<tr><td colspan="4" class="empty-state">Tier 2 not run for this doc (budget cap or no embeddings).</td></tr>`;

  return `<table class="data-table metric-profile">
    <thead><tr><th>Metric</th><th>Mean</th><th>p10</th><th>What it measures</th></tr></thead>
    <tbody>
      <tr class="tier-header"><td colspan="4"><strong>Tier 1 — Rule-based</strong></td></tr>
      ${t1Rows}
      <tr class="tier-header"><td colspan="4"><strong>Tier 2 — Embedding-based</strong></td></tr>
      ${t2Rows}
    </tbody>
  </table>`;
}

export async function renderChunkQuality(data: ReportData): Promise<string> {
  const cq = data.chunkQuality;
  if (!cq || cq.perDoc.length === 0) {
    return `<section class="chunk-quality"><h2>Chunk Quality</h2><p class="empty-state">No chunk quality data.</p></section>`;
  }

  const indexMean = cq.corpus.tokenWeightedIndexMean.toFixed(2);
  const bs = cq.corpus.bucketShare;

  // Per-doc rows with absolute bucket counts + all weakest links
  const perDocRows = cq.perDoc
    .map((d, i) => {
      const bc = d.bucketCounts;
      const total = bc.good + bc.acceptable + bc.poor;
      const links = d.weakestLinks.length > 0
        ? `<ul class="weakest-list">${d.weakestLinks.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
        : '<span class="muted">—</span>';
      return `<tr class="doc-row">
        <td class="doc-id"><a href="#cq-doc-${i}">${escapeHtml(d.docId)}</a></td>
        <td>${d.chunkQualityIndex.mean.toFixed(2)}</td>
        <td>${d.chunkQualityIndex.p10.toFixed(2)}</td>
        <td>${total}</td>
        <td><span style="color:#43a047;">${bc.good}</span></td>
        <td><span style="color:#ff6b35;">${bc.acceptable}</span></td>
        <td><span style="color:#d32f2f;font-weight:600;">${bc.poor}</span></td>
        <td>${links}</td>
      </tr>`;
    })
    .join('');

  const weakestRows = cq.corpus.weakestCorpusMetrics
    .map(m => `<tr><td>${escapeHtml(m.metric)}</td><td>${m.mean.toFixed(2)}</td></tr>`)
    .join('');

  const worstDocsRows = cq.corpus.worstDocsByP10
    .map(d => `<tr>
      <td>${escapeHtml(d.docId)}</td>
      <td style="color:${colorForScore(d.p10)};font-weight:600;">${d.p10.toFixed(2)}</td>
      <td>${escapeHtml(d.primaryWeakness)}</td>
    </tr>`)
    .join('');

  // Per-doc metric profile (collapsible)
  const docProfiles = cq.perDoc
    .map((d, i) => {
      const linksList = d.weakestLinks.length > 0
        ? `<ul class="weakest-list">${d.weakestLinks.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
        : '<p class="muted">No weak links flagged.</p>';
      return `<details id="cq-doc-${i}" class="doc-profile">
        <summary><strong>${escapeHtml(d.docId)}</strong>
          — index ${d.chunkQualityIndex.mean.toFixed(2)} (p10 ${d.chunkQualityIndex.p10.toFixed(2)})
          · ${d.chunkCountTotal} chunks (${d.chunkCountEmbedded} embedded${d.budgetCapHit ? ', cap hit' : ''})
        </summary>
        <div class="doc-profile-body">
          <h4>Weakest chunks</h4>
          ${linksList}
          <h4>Metric profile</h4>
          ${renderMetricProfile(d.tier1, d.tier2)}
        </div>
      </details>`;
    })
    .join('');

  const budgetNote = cq.corpus.totalChunksEmbedded < cq.corpus.totalChunks
    ? `<p class="section-desc">Budget mode: <strong>${cq.corpus.budgetMode}</strong> — ${cq.corpus.totalChunksEmbedded}/${cq.corpus.totalChunks} chunks embedded for Tier 2.</p>`
    : '';

  return `<section class="chunk-quality">
  <h2>Chunk Quality</h2>
  ${budgetNote}
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Token-weighted Index</div>
      <div class="kpi-value">${indexMean}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Chunks</div>
      <div class="kpi-value">${cq.corpus.totalChunks}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Good Chunks</div>
      <div class="kpi-value" style="color:#43a047;">${(bs.good * 100).toFixed(0)}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Poor Chunks</div>
      <div class="kpi-value" style="color:#d32f2f;">${(bs.poor * 100).toFixed(0)}%</div>
    </div>
  </div>
  <div class="bucket-bar" style="display:flex;height:24px;border-radius:4px;overflow:hidden;margin:1rem 0;">
    <div style="background:#43a047;width:${(bs.good * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">good ${(bs.good * 100).toFixed(0)}%</div>
    <div style="background:#ff6b35;width:${(bs.acceptable * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">acceptable ${(bs.acceptable * 100).toFixed(0)}%</div>
    <div style="background:#d32f2f;width:${(bs.poor * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">poor ${(bs.poor * 100).toFixed(0)}%</div>
  </div>

  <h3>Weakest Corpus Metrics</h3>
  <p class="section-desc muted">Lowest-scoring metrics averaged across the entire corpus — the levers most likely to lift chunk quality globally.</p>
  <table class="data-table">
    <thead><tr><th>Metric</th><th>Mean</th></tr></thead>
    <tbody>${weakestRows}</tbody>
  </table>

  ${worstDocsRows ? `
  <h3>Worst Documents by p10</h3>
  <p class="section-desc muted">Documents with the worst bottom-decile chunk quality — start here when tuning.</p>
  <table class="data-table">
    <thead><tr><th>Doc ID</th><th>p10</th><th>Primary Weakness</th></tr></thead>
    <tbody>${worstDocsRows}</tbody>
  </table>` : ''}

  <h3>Per-Document Chunk Quality</h3>
  <p class="section-desc muted">Absolute counts per bucket. Click a doc ID to jump to its full metric profile below.</p>
  <table class="data-table">
    <thead><tr>
      <th>Doc ID</th><th>Index Mean</th><th>p10</th>
      <th>Total</th><th>Good</th><th>Acc.</th><th>Poor</th>
      <th>Weakest chunks</th>
    </tr></thead>
    <tbody>${perDocRows}</tbody>
  </table>

  <h3>Per-Document Metric Profiles</h3>
  <p class="section-desc muted">Expand a document to see all 9 metrics (Tier 1 rule-based + Tier 2 embedding-based) with a hint explaining what each one measures and how to act on a low score.</p>
  <div class="doc-profiles">${docProfiles}</div>

  <style>
    .chunk-quality .weakest-list { margin: 0; padding-left: 1.1em; font-size: .85em; }
    .chunk-quality .weakest-list li { margin: .15em 0; }
    .chunk-quality .doc-profile { margin: .5rem 0; border: 1px solid #2a2f36; border-radius: 4px; background: #161a1f; }
    .chunk-quality .doc-profile summary { padding: .6rem .8rem; cursor: pointer; font-family: inherit; }
    .chunk-quality .doc-profile[open] summary { border-bottom: 1px solid #2a2f36; }
    .chunk-quality .doc-profile-body { padding: .8rem; }
    .chunk-quality .doc-profile-body h4 { margin: .5rem 0 .3rem; font-size: .9em; text-transform: uppercase; letter-spacing: .05em; color: #aab; }
    .chunk-quality .metric-profile td.metric-hint { color: #aab; font-size: .85em; }
    .chunk-quality .metric-profile tr.tier-header td { background: #1a1f25; color: #ff6b35; font-size: .85em; letter-spacing: .05em; }
    .chunk-quality .muted { color: #888; }
    .chunk-quality .doc-id a { color: #ff6b35; text-decoration: none; }
    .chunk-quality .doc-id a:hover { text-decoration: underline; }
  </style>
</section>`;
}
