// Component exports — all render functions return HTML strings
// Each component is independent and called with report data + target element ID

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

// Phase 1 stubs — to be implemented in subsequent phases
export async function renderHeader(data: ReportData): Promise<string> {
  return `<header class="dashboard-header">
    <h1>${data.scanId}</h1>
    <p class="timestamp">${data.timestamp}</p>
  </header>`;
}

export async function renderKpiCards(data: ReportData): Promise<string> {
  return `<section class="kpi-cards">
    <div class="kpi-card">
      <h3>Files Parsed</h3>
      <div class="kpi-value">${data.summary.parsedFiles}/${data.summary.totalFiles}</div>
    </div>
    <div class="kpi-card">
      <h3>Version Pairs</h3>
      <div class="kpi-value">${data.summary.versionPairs}</div>
    </div>
    <div class="kpi-card">
      <h3>References</h3>
      <div class="kpi-value">${data.summary.references}</div>
    </div>
    <div class="kpi-card">
      <h3>Requirements</h3>
      <div class="kpi-value">${data.summary.requirements}</div>
    </div>
  </section>`;
}

export async function renderQualityGauge(data: ReportData): Promise<string> {
  return `<section class="quality-gauge">
    <h2>Data Quality Assessment</h2>
    <canvas id="quality-chart"></canvas>
  </section>`;
}

export async function renderDocumentDistribution(data: ReportData): Promise<string> {
  return `<section class="document-distribution">
    <h2>Document Distribution & Metadata</h2>
    <canvas id="distribution-chart"></canvas>
  </section>`;
}

export async function renderVersionAnalysis(data: ReportData): Promise<string> {
  return `<section class="version-analysis">
    <h2>Version Pairs & Clustering</h2>
    <canvas id="version-chart"></canvas>
    <div id="version-tree"></div>
  </section>`;
}

export async function renderRequirementsLandscape(data: ReportData): Promise<string> {
  return `<section class="requirements-landscape">
    <h2>Requirements Landscape</h2>
    <canvas id="requirements-chart"></canvas>
  </section>`;
}

export async function renderReferenceGraph(data: ReportData): Promise<string> {
  return `<section class="reference-graph">
    <h2>References & Graph Resolution</h2>
    <canvas id="reference-chart"></canvas>
    <div id="reference-network"></div>
  </section>`;
}

export async function renderParseHealth(data: ReportData): Promise<string> {
  return `<section class="parse-health">
    <h2>Parse Health & OCR Status</h2>
    <canvas id="parse-health-chart"></canvas>
  </section>`;
}

export async function renderRagDecisions(data: ReportData): Promise<string> {
  return `<section class="rag-decisions">
    <h2>RAG Architecture Recommendations</h2>
    <div id="consistency-checks"></div>
  </section>`;
}

export async function renderFooter(data: ReportData): Promise<string> {
  return `<footer class="dashboard-footer">
    <p>Huginn Document Intelligence — Scan ID: ${data.scanId}</p>
  </footer>`;
}
