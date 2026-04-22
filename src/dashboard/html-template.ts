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
      margin: 1rem 0;
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

    /* Footer */
    .dashboard-footer {
      background-color: ${COLORS.background};
      text-align: center;
      color: ${COLORS.textSecondary};
      font-size: 0.85em;
      padding: 1.5rem;
      margin-top: 3rem;
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

  <!-- Chart.js (will be embedded in subsequent phase) -->
  <script>
    // Placeholder for Chart.js initialization
    // Phase 1 will add actual chart rendering logic here
    console.log('Dashboard loaded');
  </script>
</body>
</html>`;
}
