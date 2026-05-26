import type { ReportData } from '../lib/report-types.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function renderChunkQuality(data: ReportData): Promise<string> {
  const cq = data.chunkQuality;
  if (!cq || cq.perDoc.length === 0) {
    return `<section class="chunk-quality"><h2>Chunk Quality</h2><p class="empty-state">No chunk quality data.</p></section>`;
  }

  const indexMean = cq.corpus.tokenWeightedIndexMean.toFixed(2);
  const bs = cq.corpus.bucketShare;

  const perDocRows = cq.perDoc
    .map(d =>
      `<tr><td>${escapeHtml(d.docId)}</td><td>${d.chunkQualityIndex.mean.toFixed(2)}</td>` +
      `<td>${d.chunkQualityIndex.p10.toFixed(2)}</td><td>${escapeHtml(d.weakestLinks[0] ?? '')}</td></tr>`,
    )
    .join('');

  const weakestRows = cq.corpus.weakestCorpusMetrics
    .map(m => `<tr><td>${escapeHtml(m.metric)}</td><td>${m.mean.toFixed(2)}</td></tr>`)
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
  </div>
  <div class="bucket-bar" style="display:flex;height:24px;border-radius:4px;overflow:hidden;margin:1rem 0;">
    <div style="background:#43a047;width:${(bs.good * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">good ${(bs.good * 100).toFixed(0)}%</div>
    <div style="background:#ff6b35;width:${(bs.acceptable * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">acceptable ${(bs.acceptable * 100).toFixed(0)}%</div>
    <div style="background:#d32f2f;width:${(bs.poor * 100).toFixed(1)}%;color:#fff;text-align:center;font-size:.8em;line-height:24px;">poor ${(bs.poor * 100).toFixed(0)}%</div>
  </div>
  <h3>Weakest Corpus Metrics</h3>
  <table class="data-table">
    <thead><tr><th>Metric</th><th>Mean</th></tr></thead>
    <tbody>${weakestRows}</tbody>
  </table>
  <h3>Per-Document Chunk Quality</h3>
  <table class="data-table">
    <thead><tr><th>Doc ID</th><th>Index Mean</th><th>p10</th><th>Primary Weakness</th></tr></thead>
    <tbody>${perDocRows}</tbody>
  </table>
</section>`;
}
