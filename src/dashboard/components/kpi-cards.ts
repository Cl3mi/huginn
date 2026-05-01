import type { ReportData } from '../lib/report-types.js';

export async function renderKpiCards(data: ReportData): Promise<string> {
  const highPairs = data.versionPairs.filter((p) => p.confidence === 'HIGH').length;
  const allPairs = data.versionPairs.length;
  const totalRefs = data.references.length;
  const normRefs = data.references.filter((r) => ['iso_norm','din_norm','en_norm','vda_norm','iatf_norm'].includes(r.type)).length;
  const totalReqs = data.requirements.length;
  const safetyReqs = data.requirements.filter((r) => r.isSafetyRelevant).length;
  const failedChecks = data.consistencyChecks.filter((c) => !c.passed).length;
  const totalChecks = data.consistencyChecks.length;

  const parseRate = data.summary.totalFiles > 0 ? data.summary.parsedFiles / data.summary.totalFiles : 0;
  const parseColor = parseRate >= 0.9 ? '#43a047' : parseRate >= 0.75 ? '#ff6b35' : '#d32f2f';

  const cards: Array<{ label: string; value: string; sub: string; color: string; icon: string; section: string }> = [
    {
      label: 'PARSED',
      value: `${data.summary.parsedFiles}<span class="kpi-denom">/${data.summary.totalFiles}</span>`,
      sub: `${(parseRate * 100).toFixed(0)}% success rate`,
      color: parseColor,
      icon: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h5l3 3v10H4V1zm5 0v3h3"/></svg>`,
      section: '.parse-health',
    },
    {
      label: 'VERSION PAIRS',
      value: `${highPairs}<span class="kpi-denom">/${allPairs}</span>`,
      sub: 'HIGH confidence — click to explore',
      color: '#ff6b35',
      icon: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 8a5 5 0 0 1 10 0M8 3v5l3 3"/></svg>`,
      section: '.version-analysis',
    },
    {
      label: 'REFERENCES',
      value: `${totalRefs}`,
      sub: `${normRefs} norm references`,
      color: '#1e88e5',
      icon: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l4 4-4 4M4 6h8M4 10h5"/></svg>`,
      section: '.reference-graph',
    },
    {
      label: 'REQUIREMENTS',
      value: `${totalReqs}`,
      sub: safetyReqs > 0 ? `<span style="color:#d32f2f">⚠ ${safetyReqs} safety-critical — click to filter</span>` : 'No safety flags',
      color: safetyReqs > 0 ? '#d32f2f' : '#43a047',
      icon: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2l1 5h5l-4 3 1 5-4-3-4 3 1-5-4-3h5z"/></svg>`,
      section: '.requirements-landscape',
    },
    {
      label: 'QA CHECKS',
      value: `${totalChecks - failedChecks}<span class="kpi-denom">/${totalChecks}</span>`,
      sub: failedChecks === 0 ? 'All checks passing' : `${failedChecks} check${failedChecks !== 1 ? 's' : ''} failing`,
      color: failedChecks === 0 ? '#43a047' : '#d32f2f',
      icon: `<svg viewBox="0 0 16 16" fill="currentColor"><polyline points="3,8 6,11 13,4"/></svg>`,
      section: '.rag-decisions',
    },
  ];

  const cardHtml = cards
    .map(
      (c) => `<div class="kpi-card" style="--kpi-accent:${c.color}" role="button" tabindex="0"
        onclick="var el=document.querySelector('${c.section}');if(el)el.scrollIntoView({behavior:'smooth',block:'start'})"
        onkeydown="if(event.key==='Enter'||event.key===' '){var el=document.querySelector('${c.section}');if(el)el.scrollIntoView({behavior:'smooth',block:'start'})}">
      <div class="kpi-icon" style="color:${c.color}">${c.icon}</div>
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value" style="color:${c.color}">${c.value}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`,
    )
    .join('');

  return `<section class="kpi-cards">${cardHtml}</section>`;
}
