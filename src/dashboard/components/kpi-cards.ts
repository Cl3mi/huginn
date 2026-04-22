import { formatCount } from '../lib/formatters.js';

export interface ReportData {
  scanId: string;
  summary: {
    totalFiles: number;
    parsedFiles: number;
    versionPairs: number;
    references: number;
    requirements: number;
  };
}

export async function renderKpiCards(data: ReportData): Promise<string> {
  const cards = [
    {
      title: 'Files Parsed',
      value: `${formatCount(data.summary.parsedFiles)}/${formatCount(data.summary.totalFiles)}`,
      subtitle: `${((data.summary.parsedFiles / data.summary.totalFiles) * 100).toFixed(0)}% success`,
    },
    {
      title: 'Version Pairs',
      value: formatCount(data.summary.versionPairs),
      subtitle: 'HIGH confidence clusters',
    },
    {
      title: 'References',
      value: formatCount(data.summary.references),
      subtitle: 'Norms & standards detected',
    },
    {
      title: 'Requirements',
      value: formatCount(data.summary.requirements),
      subtitle: 'MUSS/SOLL/KANN extracted',
    },
  ];

  const cardHtml = cards
    .map(
      (card) => `
    <div class="kpi-card">
      <h3 class="kpi-title">${card.title}</h3>
      <div class="kpi-value">${card.value}</div>
      <p class="kpi-subtitle">${card.subtitle}</p>
    </div>
  `,
    )
    .join('');

  return `<section class="kpi-cards">${cardHtml}</section>`;
}
