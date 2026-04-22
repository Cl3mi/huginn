// HTML template with inline CSS + Chart.js initialization
// Report data is embedded as JSON in a script tag for client-side rendering

import { COLORS, FONTS } from './lib/chart-config.js';

export function generateHtmlTemplate(reportJson: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Huginn Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      background-color: ${COLORS.background};
      color: ${COLORS.text};
      font-family: ${FONTS.sans};
      line-height: 1.6;
      font-size: 14px;
    }

    h1, h2, h3, h4 {
      font-family: ${FONTS.mono};
      font-weight: 600;
      margin-top: 1.5em;
      margin-bottom: 0.75em;
      letter-spacing: 0.5px;
    }

    h1 { font-size: 2em; }
    h2 { font-size: 1.4em; }
    h3 { font-size: 1.1em; }

    a {
      color: ${COLORS.accent.orange};
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    /* Layout */
    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }

    section {
      background-color: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      border-radius: 4px;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }

    /* Header */
    .dashboard-header {
      background: linear-gradient(135deg, ${COLORS.surface} 0%, ${COLORS.background} 100%);
      border-left: 4px solid ${COLORS.accent.orange};
      padding: 2rem;
      margin-bottom: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 2rem;
    }

    .header-content {
      flex: 1;
    }

    .dashboard-header h1 {
      font-family: ${FONTS.mono};
      font-size: 1.8em;
      margin: 0;
      color: ${COLORS.accent.orange};
    }

    .timestamp {
      color: ${COLORS.textSecondary};
      font-size: 0.9em;
      margin-top: 0.5rem;
    }

    .header-metrics {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .mq-badge, .parse-badge {
      background-color: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      padding: 1rem;
      border-radius: 4px;
      min-width: 140px;
      text-align: center;
    }

    .mq-badge {
      border-left: 3px solid ${COLORS.accent.orange};
    }

    .mq-label, .parse-label {
      display: block;
      font-size: 0.75em;
      text-transform: uppercase;
      color: ${COLORS.textSecondary};
      letter-spacing: 1px;
      margin-bottom: 0.5em;
    }

    .mq-value, .parse-value {
      display: block;
      font-family: ${FONTS.mono};
      font-size: 1.5em;
      font-weight: 700;
      color: white;
    }

    /* KPI Cards */
    .kpi-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      background: none;
      border: none;
      padding: 0;
      margin-bottom: 2rem;
    }

    .kpi-card {
      background-color: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      border-left: 3px solid ${COLORS.accent.orange};
      padding: 1.5rem;
      border-radius: 4px;
      text-align: center;
    }

    .kpi-card h3 {
      font-size: 0.9em;
      color: ${COLORS.textSecondary};
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 0.75em 0;
    }

    .kpi-value {
      font-family: ${FONTS.mono};
      font-size: 2em;
      font-weight: 700;
      color: ${COLORS.accent.orange};
    }

    /* Charts */
    canvas {
      max-height: 300px;
      margin: 1rem auto;
      display: block;
    }

    .distribution-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 1.5rem;
    }

    .chart-container {
      background-color: ${COLORS.background};
      padding: 1rem;
      border-radius: 4px;
      border: 1px solid ${COLORS.border};
    }

    .chart-container h3 {
      font-size: 0.95em;
      margin: 0 0 1rem 0;
      color: ${COLORS.textSecondary};
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Parse Health */
    .parse-health-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .parse-metric {
      background-color: ${COLORS.background};
      padding: 1rem;
      border-radius: 4px;
      border: 1px solid ${COLORS.border};
    }

    .metric-label {
      font-size: 0.85em;
      color: ${COLORS.textSecondary};
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 0.75em;
    }

    .metric-gauge {
      height: 24px;
      background-color: ${COLORS.border};
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 0.75em;
    }

    .gauge-bar {
      height: 100%;
      transition: width 0.3s ease;
    }

    .metric-value {
      font-family: ${FONTS.mono};
      font-size: 1.2em;
      font-weight: 700;
      color: ${COLORS.accent.orange};
    }

    .parse-summary {
      background-color: ${COLORS.background};
      padding: 1rem;
      border-radius: 4px;
      border-left: 3px solid ${COLORS.accent.orange};
    }

    .parse-summary h3 {
      margin: 0 0 1rem 0;
    }

    .parse-summary ul {
      list-style: none;
      padding: 0;
    }

    .parse-summary li {
      padding: 0.5em 0;
      font-size: 0.95em;
    }

    /* Gauge Layout */
    .gauge-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
      align-items: start;
    }

    .gauge-chart {
      position: relative;
      padding: 1rem;
    }

    .gauge-center {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      pointer-events: none;
    }

    .gauge-score {
      font-family: ${FONTS.mono};
      font-size: 2em;
      font-weight: 700;
      color: ${COLORS.accent.green};
    }

    .gauge-label {
      font-size: 0.8em;
      color: ${COLORS.textSecondary};
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .gauge-components h3 {
      font-size: 1em;
      margin: 0 0 1rem 0;
    }

    .color-swatch {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 2px;
      margin-right: 0.5em;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-family: ${FONTS.mono};
      font-size: 0.9em;
    }

    thead {
      background-color: ${COLORS.background};
      border-bottom: 2px solid ${COLORS.accent.orange};
    }

    th {
      padding: 0.75rem;
      text-align: left;
      text-transform: uppercase;
      font-size: 0.8em;
      letter-spacing: 1px;
      color: ${COLORS.textSecondary};
    }

    td {
      padding: 0.75rem;
      border-bottom: 1px solid ${COLORS.border};
    }

    tbody tr:hover {
      background-color: ${COLORS.background};
    }

    /* Status Badges */
    .badge {
      display: inline-block;
      padding: 0.25em 0.75em;
      border-radius: 3px;
      font-size: 0.85em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .badge.success {
      background-color: ${COLORS.accent.green};
      color: ${COLORS.background};
    }

    .badge.warning {
      background-color: ${COLORS.accent.orange};
      color: ${COLORS.background};
    }

    .badge.danger {
      background-color: ${COLORS.accent.red};
      color: white;
    }

    .badge.info {
      background-color: ${COLORS.accent.blue};
      color: white;
    }

    /* Collapsible sections */
    .collapsible {
      cursor: pointer;
      background-color: ${COLORS.background};
      padding: 1rem;
      border-left: 2px solid ${COLORS.accent.orange};
      user-select: none;
    }

    .collapsible:hover {
      background-color: ${COLORS.border};
    }

    .collapsible::before {
      content: '▸ ';
      color: ${COLORS.accent.orange};
      font-weight: bold;
      margin-right: 0.5rem;
    }

    .collapsible.active::before {
      content: '▾ ';
    }

    .collapsible-content {
      display: none;
      padding: 1rem;
      background-color: ${COLORS.background};
      border-left: 2px solid ${COLORS.accent.orange};
    }

    .collapsible.active + .collapsible-content {
      display: block;
    }

    /* Buttons */
    .btn {
      display: inline-block;
      padding: 0.5em 1.5em;
      margin: 0.5em 0.5em 0.5em 0;
      border: 1px solid ${COLORS.border};
      border-radius: 4px;
      background-color: ${COLORS.surface};
      color: ${COLORS.text};
      font-family: ${FONTS.mono};
      font-size: 0.9em;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
    }

    .btn:hover {
      background-color: ${COLORS.border};
      border-color: ${COLORS.accent.orange};
    }

    .btn-secondary {
      border-color: ${COLORS.textSecondary};
      color: ${COLORS.textSecondary};
    }

    .btn-secondary:hover {
      color: ${COLORS.accent.orange};
      border-color: ${COLORS.accent.orange};
    }

    /* Placeholders for phase stubs */
    .placeholder {
      padding: 1.5rem;
      background-color: ${COLORS.background};
      border-left: 3px solid ${COLORS.border};
      color: ${COLORS.textSecondary};
      font-size: 0.85em;
      font-style: italic;
      margin: 1rem 0;
    }

    /* Footer */
    .dashboard-footer {
      background-color: ${COLORS.background};
      color: ${COLORS.textSecondary};
      font-size: 0.85em;
      padding: 2rem;
      margin-top: 3rem;
      border-top: 1px solid ${COLORS.border};
    }

    .footer-content {
      display: flex;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .footer-credit {
      font-weight: 600;
      color: ${COLORS.text};
      margin-bottom: 0.25em;
    }

    .footer-scan-id code {
      font-family: ${FONTS.mono};
      color: ${COLORS.accent.orange};
      background-color: ${COLORS.surface};
      padding: 0.25em 0.5em;
      border-radius: 2px;
    }

    .footer-actions {
      text-align: center;
      padding-top: 1rem;
      border-top: 1px solid ${COLORS.border};
    }

    /* Responsive */
    @media (max-width: 640px) {
      .container {
        padding: 1rem;
      }

      section {
        padding: 1rem;
      }

      .kpi-cards {
        grid-template-columns: 1fr;
      }

      table {
        font-size: 0.8em;
      }

      th, td {
        padding: 0.5rem;
      }
    }

    /* Print styles */
    @media print {
      body {
        background-color: white;
        color: black;
      }

      section {
        background-color: white;
        border: 1px solid #ccc;
        page-break-inside: avoid;
      }

      .dashboard-header {
        background: white;
        border-left-color: #333;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    ${bodyContent}
  </div>

  <!-- Embedded report data -->
  <script type="application/json" id="report-data">
    ${reportJson}
  </script>

  <!-- Chart.js Library -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script>
    // Chart.js initialization placeholder
    // Phase 2 will implement actual chart rendering

    document.addEventListener('DOMContentLoaded', function() {
      const reportData = JSON.parse(document.getElementById('report-data').textContent);
      console.log('Dashboard loaded with report:', reportData.scanId);

      // Chart initialization will happen here in Phase 2
      // For now, just verify data is loaded
      if (reportData && reportData.summary) {
        console.log('Summary:', reportData.summary);
      }
    });
  </script>
</body>
</html>`;
}
