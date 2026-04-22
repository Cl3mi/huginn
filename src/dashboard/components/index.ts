// Component exports — all render functions return HTML strings
// Each component is independent and called with report data

import { renderHeader } from './header.js';
import { renderKpiCards } from './kpi-cards.js';
import { renderFooter } from './footer.js';
import { renderQualityGauge } from './quality-gauge.js';
import { renderDocumentDistribution } from './document-distribution.js';
import { renderParseHealth } from './parse-health.js';
import { renderRequirementsLandscape } from './requirements-landscape.js';
import { renderVersionAnalysis } from './version-analysis.js';
import { renderReferenceGraph } from './reference-graph.js';
import { renderRagDecisions } from './rag-decisions.js';

export interface ReportData {
  scanId: string;
  timestamp: string;
  summary: {
    totalFiles: number;
    parsedFiles: number;
    versionPairs: number;
    references: number;
    requirements: number;
    mqScore?: number;
  };
  parsed?: Array<{ filename: string; language?: string; pageCount?: number }>;
  versionPairs?: Array<{ score: number; docA: string; docB: string; confidence?: number }>;
  references?: Array<{ text: string; type: string; standard?: string; status?: string }>;
  requirements?: Array<{ type: string; category?: string; safetyFlag?: boolean; count?: number }>;
  consistencyChecks?: Record<string, { value: number; threshold?: number; pass?: boolean }>;
}

export {
  renderHeader,
  renderKpiCards,
  renderQualityGauge,
  renderDocumentDistribution,
  renderVersionAnalysis,
  renderRequirementsLandscape,
  renderReferenceGraph,
  renderParseHealth,
  renderRagDecisions,
  renderFooter,
};
