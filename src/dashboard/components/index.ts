// Component exports — all render functions return HTML strings
// Each component is independent and called with report data

import { renderHeader } from './header.js';
import { renderKpiCards } from './kpi-cards.js';
import { renderFooter } from './footer.js';

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
  versionPairs?: Array<{ score: number; docA: string; docB: string }>;
  references?: Array<{ text: string; type: string }>;
  requirements?: Array<{ type: string; category?: string; safetyFlag?: boolean }>;
  consistencyChecks?: Record<string, { value: number; threshold?: number; pass?: boolean }>;
}

export { renderHeader, renderKpiCards, renderFooter };

// Phase 2-3 component stubs (to be implemented)
export async function renderQualityGauge(data: ReportData): Promise<string> {
  return `<section class="quality-gauge">
    <h2>Data Quality Assessment</h2>
    <canvas id="quality-chart"></canvas>
    <p class="placeholder">[Phase 2: MQ gauge chart]</p>
  </section>`;
}

export async function renderDocumentDistribution(data: ReportData): Promise<string> {
  return `<section class="document-distribution">
    <h2>Document Distribution & Metadata</h2>
    <canvas id="distribution-chart"></canvas>
    <p class="placeholder">[Phase 2: Metadata charts]</p>
  </section>`;
}

export async function renderVersionAnalysis(data: ReportData): Promise<string> {
  return `<section class="version-analysis">
    <h2>Version Pairs & Clustering</h2>
    <canvas id="version-chart"></canvas>
    <div id="version-tree"></div>
    <p class="placeholder">[Phase 3: Version chain tree]</p>
  </section>`;
}

export async function renderRequirementsLandscape(data: ReportData): Promise<string> {
  return `<section class="requirements-landscape">
    <h2>Requirements Landscape</h2>
    <canvas id="requirements-chart"></canvas>
    <p class="placeholder">[Phase 2: Requirement breakdown]</p>
  </section>`;
}

export async function renderReferenceGraph(data: ReportData): Promise<string> {
  return `<section class="reference-graph">
    <h2>References & Graph Resolution</h2>
    <canvas id="reference-chart"></canvas>
    <div id="reference-network"></div>
    <p class="placeholder">[Phase 3: Reference network]</p>
  </section>`;
}

export async function renderParseHealth(data: ReportData): Promise<string> {
  return `<section class="parse-health">
    <h2>Parse Health & OCR Status</h2>
    <canvas id="parse-health-chart"></canvas>
    <p class="placeholder">[Phase 2: Parse health chart]</p>
  </section>`;
}

export async function renderRagDecisions(data: ReportData): Promise<string> {
  return `<section class="rag-decisions">
    <h2>RAG Architecture Recommendations</h2>
    <div id="consistency-checks"></div>
    <p class="placeholder">[Phase 2: Consistency checks]</p>
  </section>`;
}
