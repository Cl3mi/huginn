// HTML template with inline CSS + Chart.js initialization
// Report data is embedded as JSON in a script tag for client-side rendering

import { COLORS, FONTS } from './lib/chart-config.js';

export function generateHtmlTemplate(reportJson: string, bodyContent: string, chartJsSource?: string): string {
  const chartJsTag = chartJsSource
    ? `<script>${chartJsSource}</script>`
    : `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <!-- NOTE: CDN fallback — run with --inline-assets for fully offline output -->`;
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

    /* Floating quick-nav — only visible on wide screens */
    #quick-nav {
      display: none;
    }
    @media (min-width: 1700px) {
      #quick-nav {
        display: flex;
        flex-direction: column;
        position: fixed;
        right: 1.25rem;
        top: 50%;
        transform: translateY(-50%);
        z-index: 200;
        background: rgba(26,31,38,0.97);
        border: 1px solid ${COLORS.border};
        border-radius: 8px;
        padding: .65rem .4rem;
        gap: .1rem;
        max-height: 90vh;
        overflow-y: auto;
        backdrop-filter: blur(6px);
        box-shadow: 0 4px 24px rgba(0,0,0,.5);
      }
    }

    .qnav-label {
      font-size: .58em;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: ${COLORS.textSecondary};
      padding: .1rem .6rem .5rem;
      font-family: ${FONTS.mono};
      white-space: nowrap;
      border-bottom: 1px solid ${COLORS.border};
      margin-bottom: .3rem;
    }

    .qnav-link {
      display: block;
      font-size: .7em;
      font-family: ${FONTS.mono};
      color: ${COLORS.textSecondary};
      text-decoration: none;
      padding: .3rem .6rem;
      border-radius: 4px;
      border-left: 2px solid transparent;
      white-space: nowrap;
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: color .12s, border-color .12s, background .12s;
    }
    .qnav-link:hover {
      color: ${COLORS.text};
      background: rgba(255,255,255,.04);
    }
    .qnav-link.qnav-active {
      color: ${COLORS.accent.orange};
      border-left-color: ${COLORS.accent.orange};
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

    .header-content { flex: 1; }

    .header-logo {
      font-family: ${FONTS.mono};
      font-size: 0.75em;
      letter-spacing: 4px;
      text-transform: uppercase;
      color: ${COLORS.accent.orange};
      opacity: 0.7;
      margin-bottom: 0.4rem;
    }

    .header-scan-id {
      font-family: ${FONTS.mono};
      font-size: 1.4em;
      margin: 0 0 0.3rem 0;
      color: ${COLORS.text};
    }

    .timestamp {
      color: ${COLORS.textSecondary};
      font-size: 0.85em;
      margin-top: 0;
    }

    .header-metrics {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .header-metric {
      background-color: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      padding: .9rem 1.2rem;
      border-radius: 4px;
      min-width: 120px;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: .2rem;
    }

    .hm-label {
      font-size: 0.7em;
      text-transform: uppercase;
      color: ${COLORS.textSecondary};
      letter-spacing: 1.5px;
    }

    .hm-value {
      font-family: ${FONTS.mono};
      font-size: 1.6em;
      font-weight: 700;
      line-height: 1;
    }

    .hm-unit {
      font-size: 0.5em;
      font-weight: 400;
      color: ${COLORS.textSecondary};
    }

    .hm-sub {
      font-size: 0.75em;
      color: ${COLORS.textSecondary};
    }

    /* Section utilities */
    .section-desc {
      color: ${COLORS.textSecondary};
      font-size: 0.9em;
      margin: -.25rem 0 1.25rem 0;
    }

    .empty-state {
      color: ${COLORS.textSecondary};
      font-style: italic;
      padding: 1.25rem 0;
    }

    /* KPI Cards */
    .kpi-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      background: none;
      border: none;
      padding: 0;
      margin-bottom: 2rem;
    }

    .kpi-card {
      background-color: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      border-top: 3px solid var(--kpi-accent, ${COLORS.accent.orange});
      padding: 1.25rem 1rem;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      gap: .3rem;
    }

    .kpi-icon {
      width: 20px;
      height: 20px;
      margin-bottom: .25rem;
      flex-shrink: 0;
    }

    .kpi-icon svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .kpi-label {
      font-size: 0.7em;
      color: ${COLORS.textSecondary};
      text-transform: uppercase;
      letter-spacing: 1.5px;
    }

    .kpi-value {
      font-family: ${FONTS.mono};
      font-size: 1.9em;
      font-weight: 700;
      line-height: 1;
    }

    .kpi-denom {
      font-size: 0.5em;
      font-weight: 400;
      color: ${COLORS.textSecondary};
    }

    .kpi-sub {
      font-size: 0.8em;
      color: ${COLORS.textSecondary};
      margin-top: .1rem;
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
      grid-template-columns: auto 1fr;
      gap: 2.5rem;
      align-items: start;
    }

    .gauge-chart-wrap {
      position: relative;
      width: 220px;
      flex-shrink: 0;
    }

    .gauge-center-text {
      position: absolute;
      bottom: 8px;
      left: 0;
      right: 0;
      text-align: center;
      pointer-events: none;
    }

    .gauge-score {
      font-family: ${FONTS.mono};
      font-size: 2.2em;
      font-weight: 700;
      line-height: 1;
    }

    .gauge-sub {
      font-size: 0.8em;
      color: ${COLORS.textSecondary};
    }

    .gauge-components {
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .component-table {
      margin: 0;
    }

    .component-table td {
      padding: .45rem .6rem;
      font-size: .88em;
    }

    .mini-bar-wrap {
      height: 8px;
      background: ${COLORS.border};
      border-radius: 4px;
      overflow: hidden;
      width: 120px;
    }

    .mini-bar {
      height: 100%;
      border-radius: 4px;
    }

    .calibration-note {
      font-size: 0.8em;
      color: ${COLORS.textSecondary};
      margin-top: .75rem;
      font-style: italic;
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

    /* Requirements */
    .req-summary {
      margin-bottom: 1.5rem;
      color: ${COLORS.textSecondary};
      font-size: 0.9em;
    }

    .req-total {
      font-family: ${FONTS.mono};
    }

    /* Document Distribution */
    .dist-stat-row {
      display: flex;
      flex-wrap: wrap;
      gap: .75rem 1.5rem;
      margin-bottom: 1.5rem;
      font-size: 0.9em;
    }

    .dist-stat strong {
      font-family: ${FONTS.mono};
      color: ${COLORS.text};
    }

    .dist-stat {
      color: ${COLORS.textSecondary};
    }

    /* Version Analysis */
    .conf-badge {
      font-family: ${FONTS.mono};
      font-size: 0.85em;
      font-weight: 600;
    }

    .flag-badge {
      display: inline-block;
      font-size: 0.7em;
      background: rgba(255,107,53,.2);
      color: ${COLORS.accent.orange};
      border: 1px solid ${COLORS.accent.orange};
      border-radius: 3px;
      padding: .1em .4em;
      font-family: ${FONTS.mono};
      vertical-align: middle;
      margin-left: .3em;
    }

    .pairs-table {
      margin-top: 1.5rem;
    }

    .pairs-table h3 {
      font-size: 1em;
      margin: 0 0 1rem 0;
    }

    .score-badge {
      display: inline-block;
      padding: 0.2em 0.6em;
      border-radius: 3px;
      font-family: ${FONTS.mono};
      font-size: 0.85em;
      font-weight: 700;
    }

    .score-badge.score-high  { background: #43a047; color: #fff; }
    .score-badge.score-medium { background: #ff6b35; color: #fff; }
    .score-badge.score-low   { background: #607d8b; color: #fff; }

    .doc-name {
      font-family: ${FONTS.mono};
      font-size: 0.85em;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chain-viz {
      overflow-x: auto;
      min-height: 60px;
    }

    .no-data {
      color: ${COLORS.textSecondary};
      font-style: italic;
      padding: 1rem;
    }

    /* Reference Graph */
    .ref-overview-grid {
      display: grid;
      grid-template-columns: 300px 1fr;
      gap: 1.5rem;
      align-items: start;
      margin-bottom: 1.5rem;
    }

    .ref-resolution-block {
      background-color: ${COLORS.background};
      padding: 1rem;
      border-radius: 4px;
      border: 1px solid ${COLORS.border};
    }

    .ref-breakdown {
      display: flex;
      flex-direction: column;
      gap: .3rem;
      margin-top: .6rem;
      font-size: .82em;
      font-family: ${FONTS.mono};
    }

    .rb-item { }
    .rb-ok  { color: #43a047; }
    .rb-ext { color: #1e88e5; }
    .rb-miss { color: #d32f2f; }

    .norm-badges-block {
      background-color: ${COLORS.background};
      padding: 1rem;
      border-radius: 4px;
      border: 1px solid ${COLORS.border};
    }

    .norm-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .norm-badge {
      background-color: ${COLORS.background};
      border: 1px solid ${COLORS.accent.blue};
      color: ${COLORS.accent.blue};
      padding: 0.2em 0.6em;
      border-radius: 3px;
      font-family: ${FONTS.mono};
      font-size: 0.78em;
    }

    .norm-badge-warn {
      border-color: ${COLORS.accent.orange};
      color: ${COLORS.accent.orange};
    }

    .missing-refs-block {
      margin-top: 1.25rem;
      background: rgba(255,107,53,.07);
      border: 1px solid ${COLORS.accent.orange};
      border-radius: 4px;
      padding: .75rem 1rem;
    }

    .failed-files-block {
      margin-top: 1.25rem;
    }

    /* Safety badge */
    .safety-badge {
      background-color: rgba(211, 47, 47, 0.15);
      border: 1px solid ${COLORS.accent.red};
      border-left: 4px solid ${COLORS.accent.red};
      padding: 0.75rem 1rem;
      border-radius: 4px;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .safety-icon {
      color: ${COLORS.accent.red};
      font-size: 1.2em;
    }

    .safety-text {
      color: ${COLORS.accent.red};
      font-weight: 600;
      font-family: ${FONTS.mono};
      font-size: 0.9em;
    }

    /* Consistency checks */
    .consistency-summary {
      background-color: ${COLORS.background};
      border-left: 4px solid ${COLORS.accent.green};
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-family: ${FONTS.mono};
      font-size: 0.9em;
    }

    .consistency-table { margin-top: 0; }

    .check-desc {
      font-size: 0.85em;
      color: ${COLORS.textSecondary};
      font-weight: 400;
      font-family: ${FONTS.sans};
    }

    /* Responsive */
    @media (max-width: 900px) {
      .ref-overview-grid { grid-template-columns: 1fr; }
      .gauge-container { grid-template-columns: 1fr; }
      .gauge-chart-wrap { width: 100%; }
    }

    @media (max-width: 640px) {
      .container { padding: 1rem; }
      section { padding: 1rem; }
      .kpi-cards { grid-template-columns: 1fr 1fr; }
      .dashboard-header { flex-direction: column; }
      .header-metrics { justify-content: flex-start; }
      table { font-size: 0.8em; }
      th, td { padding: 0.5rem; }
    }

    @media (max-width: 400px) {
      .kpi-cards { grid-template-columns: 1fr; }
    }

    /* Table search */
    .table-search-wrap {
      display: flex;
      align-items: center;
      gap: .75rem;
      margin-bottom: 1rem;
    }

    .table-search {
      background: ${COLORS.background};
      border: 1px solid ${COLORS.border};
      border-radius: 4px;
      color: ${COLORS.text};
      font-family: ${FONTS.mono};
      font-size: .85em;
      padding: .4em .8em;
      width: 280px;
      outline: none;
    }

    .table-search:focus {
      border-color: ${COLORS.accent.orange};
    }

    .table-search-count {
      font-size: .8em;
      color: ${COLORS.textSecondary};
      font-family: ${FONTS.mono};
    }

    .row-hidden { display: none; }

    /* Interactive filter tabs */
    .filter-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: .4rem;
      margin-bottom: 1rem;
      align-items: center;
    }

    .filter-tab {
      background: ${COLORS.background};
      border: 1px solid ${COLORS.border};
      color: ${COLORS.textSecondary};
      font-family: ${FONTS.mono};
      font-size: .78em;
      padding: .3em .85em;
      border-radius: 3px;
      cursor: pointer;
      transition: all .12s;
      text-transform: uppercase;
      letter-spacing: .5px;
      line-height: 1.4;
    }

    .filter-tab:hover {
      border-color: ${COLORS.accent.orange};
      color: ${COLORS.accent.orange};
    }

    .filter-tab.active {
      background: ${COLORS.accent.orange};
      border-color: ${COLORS.accent.orange};
      color: #fff;
      font-weight: 600;
    }

    .filter-tab.safety-active {
      background: ${COLORS.accent.red};
      border-color: ${COLORS.accent.red};
      color: #fff;
      font-weight: 600;
    }

    /* Clickable document links */
    .doc-link {
      color: ${COLORS.accent.blue};
      text-decoration: none;
      font-family: ${FONTS.mono};
      cursor: pointer;
    }

    .doc-link:hover {
      color: ${COLORS.accent.orange};
      text-decoration: underline;
    }

    .doc-name-cell {
      display: flex;
      flex-direction: column;
      gap: .15rem;
    }

    .doc-meta-tag {
      font-size: .72em;
      color: ${COLORS.textSecondary};
      font-family: ${FONTS.mono};
    }

    /* Requirement type badges */
    .req-type-badge {
      display: inline-block;
      padding: .15em .5em;
      border-radius: 3px;
      font-family: ${FONTS.mono};
      font-size: .78em;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: .3px;
    }

    /* Requirements table section */
    .req-table-section { margin-top: 2rem; }
    .req-table-section h3 { margin-bottom: 1rem; }
    .req-table-controls {
      display: flex;
      flex-wrap: wrap;
      gap: .5rem 1rem;
      align-items: center;
      margin-bottom: .75rem;
    }

    /* KPI cards — interactive */
    .kpi-card { cursor: pointer; transition: border-color .15s, transform .1s; }
    .kpi-card:hover { border-color: var(--kpi-accent, ${COLORS.accent.orange}); transform: translateY(-1px); }

    /* Document detail modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.8);
      z-index: 2000;
      align-items: flex-start;
      justify-content: center;
      padding: 2rem 1rem;
      overflow-y: auto;
    }

    .modal-panel {
      background: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      border-top: 3px solid ${COLORS.accent.orange};
      border-radius: 4px;
      width: 100%;
      max-width: 860px;
      position: relative;
      margin: auto;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid ${COLORS.border};
      position: sticky;
      top: 0;
      background: ${COLORS.surface};
      z-index: 1;
      gap: 1rem;
    }

    .modal-header h3 {
      margin: 0;
      font-size: 1em;
      font-family: ${FONTS.mono};
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .modal-close {
      background: none;
      border: 1px solid ${COLORS.border};
      color: ${COLORS.textSecondary};
      font-size: .9em;
      width: 2rem;
      height: 2rem;
      border-radius: 4px;
      cursor: pointer;
      flex-shrink: 0;
      transition: all .12s;
      line-height: 1;
    }

    .modal-close:hover { color: ${COLORS.accent.orange}; border-color: ${COLORS.accent.orange}; }

    .modal-body {
      padding: 1.25rem;
      overflow-y: auto;
      max-height: calc(90vh - 4rem);
    }

    .modal-section { margin-bottom: 1.5rem; }

    .modal-section h4 {
      font-family: ${FONTS.mono};
      font-size: .82em;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: ${COLORS.accent.orange};
      margin: 0 0 .6rem 0;
      padding-bottom: .4rem;
      border-bottom: 1px solid ${COLORS.border};
    }

    .modal-table { font-size: .84em; margin: 0; }
    .modal-table td:first-child { color: ${COLORS.textSecondary}; width: 28%; }
    .modal-table td { padding: .4rem .6rem; }
    .modal-table th { padding: .4rem .6rem; font-size: .75em; }

    .modal-headings {
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid ${COLORS.border};
      border-radius: 4px;
      padding: .4rem .75rem;
      background: ${COLORS.background};
      font-family: ${FONTS.mono};
    }

    /* Document browser */
    .doc-browser {
      margin-top: 2rem;
      border-top: 1px solid ${COLORS.border};
      padding-top: 1.5rem;
    }

    .doc-browser h3 { margin-top: 0; }

    .dist-filter-row {
      display: flex;
      align-items: center;
      gap: .75rem;
      flex-wrap: wrap;
      margin-bottom: .4rem;
    }

    .dist-filter-label {
      font-size: .75em;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: ${COLORS.textSecondary};
      font-family: ${FONTS.mono};
      white-space: nowrap;
      min-width: 70px;
    }

    /* File tree */
    .file-tree-section h2 { margin-bottom: .5rem; }

    .tree-toolbar {
      display: flex;
      align-items: center;
      gap: .6rem;
      flex-wrap: wrap;
      margin-bottom: 1rem;
    }

    .tree-btn {
      background: ${COLORS.surface};
      border: 1px solid ${COLORS.border};
      color: ${COLORS.text};
      font-family: ${FONTS.mono};
      font-size: .75em;
      padding: .3rem .8rem;
      border-radius: 4px;
      cursor: pointer;
    }
    .tree-btn:hover { border-color: ${COLORS.accent.orange}; color: ${COLORS.accent.orange}; }

    .file-tree {
      border: 1px solid ${COLORS.border};
      border-radius: 6px;
      padding: .75rem .75rem .75rem .5rem;
      background: ${COLORS.background};
      max-height: 70vh;
      overflow-y: auto;
      font-family: ${FONTS.mono};
      font-size: .83em;
      line-height: 1;
    }

    /* Children container — the vertical tree line */
    .tree-children {
      margin-left: .85rem;
      padding-left: .9rem;
      border-left: 1px solid ${COLORS.border};
    }

    .tree-dir { margin: .05rem 0; }

    .tree-dir-summary {
      display: flex;
      align-items: center;
      gap: .4rem;
      padding: .28rem .4rem;
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
      list-style: none;
      margin-left: -.4rem;
    }
    .tree-dir-summary::-webkit-details-marker { display: none; }

    .tree-arrow {
      display: inline-block;
      width: .7em;
      font-size: .7em;
      color: ${COLORS.textSecondary};
      flex-shrink: 0;
      transition: transform .15s;
    }
    .tree-arrow::before { content: '▶'; }
    details[open] > .tree-dir-summary .tree-arrow { transform: rotate(90deg); }

    .tree-dir-summary:hover { background: ${COLORS.surface}; }

    .tree-dir-icon { font-size: .85em; flex-shrink: 0; }

    .tree-dir-name {
      color: ${COLORS.text};
      font-weight: 600;
      letter-spacing: .01em;
    }

    .tree-dir-count {
      font-size: .72em;
      color: ${COLORS.textSecondary};
      margin-left: auto;
      padding-right: .2rem;
      white-space: nowrap;
    }

    .tree-file {
      display: flex;
      align-items: center;
      gap: .35rem;
      padding: .2rem .4rem;
      border-radius: 3px;
      margin-left: -.4rem;
    }
    .tree-file:hover { background: ${COLORS.surface}; }

    .tree-file-icon { font-size: .8em; flex-shrink: 0; opacity: .5; }

    .tree-file a { color: ${COLORS.accent.blue}; text-decoration: none; }
    .tree-file a:hover { text-decoration: underline; }

    .tree-ext-badge {
      font-size: .62em;
      font-family: ${FONTS.mono};
      border: 1px solid;
      border-radius: 3px;
      padding: 0 4px;
      flex-shrink: 0;
    }

    .tree-meta {
      font-size: .73em;
      color: ${COLORS.textSecondary};
      margin-left: .1em;
    }
    .tree-meta.mono { font-family: ${FONTS.mono}; }

    .tree-doctype {
      font-size: .68em;
      color: ${COLORS.textSecondary};
      margin-left: .3em;
      opacity: .7;
      text-transform: capitalize;
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

      .btn, .table-search-wrap { display: none; }
    }
  </style>
</head>
<body>
  <nav id="quick-nav" aria-label="Page sections">
    <div class="qnav-label">Sections</div>
  </nav>

  <div class="container">
    ${bodyContent}
  </div>

  <!-- Document detail modal — populated by JS, no data leaves this page -->
  <div id="doc-modal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-panel">
      <div class="modal-header">
        <h3 id="modal-title">Document Details</h3>
        <button class="modal-close" onclick="closeDocModal()" title="Close (Esc)">✕</button>
      </div>
      <div id="modal-body" class="modal-body"></div>
    </div>
  </div>

  <!-- Embedded report data -->
  <script type="application/json" id="report-data">
    ${reportJson}
  </script>

  <!-- Global interactive data layer — reads embedded JSON, no network requests -->
  <script>
  (function() {
    var _el = document.getElementById('report-data');
    var _d = {};
    try { _d = _el ? JSON.parse(_el.textContent || '{}') : {}; } catch(e) {}
    window.__huginnData = _d;

    // Lookup maps built once from embedded data
    var _byPath   = new Map((_d.files        || []).map(function(f){  return [f.path,  f];  }));
    var _byId     = new Map((_d.files        || []).map(function(f){  return [f.id,    f];  }));
    var _parsed   = new Map((_d.parsed       || []).map(function(p){  return [p.id,    p];  }));
    var _fpById   = new Map((_d.fingerprints || []).map(function(fp){ return [fp.docId, fp];}));
    var _reqs     = Object.create(null);
    var _refs     = Object.create(null);
    var _vpById = Object.create(null);   // doc ID → version pairs[]
    (_d.requirements || []).forEach(function(r){ (_reqs[r.docId] = _reqs[r.docId] || []).push(r); });
    (_d.references   || []).forEach(function(r){ (_refs[r.docId] = _refs[r.docId] || []).push(r); });
    (_d.versionPairs || []).forEach(function(vp){
      (_vpById[vp.docA] = _vpById[vp.docA] || []).push(vp);
      (_vpById[vp.docB] = _vpById[vp.docB] || []).push(vp);
    });

    function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
    function _bytes(b){ b=b||0; if(b<1024) return b+' B'; if(b<1048576) return (b/1024).toFixed(0)+' KB'; return (b/1048576).toFixed(1)+' MB'; }
    function _pct(n){ return n!=null ? (n*100).toFixed(1)+'%' : '—'; }
    function _row(label, value){ return '<tr><td>'+label+'</td><td>'+value+'</td></tr>'; }

    function _buildModal(file, parsedDoc, reqs, refs, vps, fp){
      var html = '';

      // ── 1. Document Info ──────────────────────────────────────────────────────
      html += '<div class="modal-section"><h4>Document Info</h4><table class="modal-table"><tbody>';
      if(file){
        html += _row('Path', '<span style="word-break:break-all;font-family:monospace;font-size:.78em">'+_esc(file.path)+'</span>');
        html += _row('Extension', _esc(file.extension||'—'));
        html += _row('Size', _bytes(file.sizeBytes));
        if(file.sha256)                   html += _row('SHA-256', '<span style="font-family:monospace;font-size:.73em;color:#a0a4ab">'+_esc(file.sha256.slice(0,32))+'…</span>');
        if(file.modifiedAt)               html += _row('File date', _esc(file.modifiedAt.slice(0,10)));
        if(file.inferredCustomer)         html += _row('Customer', _esc(file.inferredCustomer));
        if(file.inferredProject)          html += _row('Project',  _esc(file.inferredProject));
        if(file.inferredDocumentCategory) html += _row('Category', _esc(file.inferredDocumentCategory));
      }
      if(parsedDoc){
        if(parsedDoc.dateSignals && parsedDoc.dateSignals.bestDate)
          html += _row('Best date', '<strong>'+_esc(parsedDoc.dateSignals.bestDate)+'</strong>'
            +(parsedDoc.dateSignals.internalDateSource?' <span style="color:#a0a4ab;font-size:.8em">via '+_esc(parsedDoc.dateSignals.internalDateSource)+'</span>':''));
        if(parsedDoc.language)           html += _row('Language', _esc(parsedDoc.language.toUpperCase()));
        if(parsedDoc.tokenCountEstimate) html += _row('Token estimate', '<strong>'+parsedDoc.tokenCountEstimate.toLocaleString()+'</strong>'
          +(parsedDoc.charCount?' <span style="color:#a0a4ab;font-size:.8em">('+_bytes(parsedDoc.charCount)+' text)</span>':''));
        if(parsedDoc.pageCount)          html += _row('Pages', String(parsedDoc.pageCount));
        if(parsedDoc.headingCount!=null) html += _row('Headings', String(parsedDoc.headingCount)
          +(parsedDoc.hasNumberedHeadings?' <span style="color:#43a047;font-size:.78em">numbered</span>':''));
        if(parsedDoc.tableCount!=null)   html += _row('Tables', String(parsedDoc.tableCount));
        if(parsedDoc.imageCount)         html += _row('Images', String(parsedDoc.imageCount));
        if(parsedDoc.parserUsed)         html += _row('Parser', _esc(parsedDoc.parserUsed));
        if(parsedDoc.detectedDocType)    html += _row('Doc type', _esc(parsedDoc.detectedDocType));
        if(parsedDoc.detectedOem)        html += _row('OEM', _esc(parsedDoc.detectedOem));
        if(parsedDoc.pdfClassification)  html += _row('PDF class', _esc(parsedDoc.pdfClassification));
        if(parsedDoc.isScannedPdf)       html += _row('Scanned PDF', '<span style="color:#ff9800">⚠ Yes</span>'
          +(parsedDoc.scannedPageRatio?' ('+_pct(parsedDoc.scannedPageRatio)+' pages)':''));
        if(parsedDoc.isOcrRequired)      html += _row('OCR', '<span style="color:#ff9800">⚠ Required</span>');
        if(parsedDoc.parseSuccess===false && parsedDoc.parseFailureReason)
          html += _row('Parse error', '<span style="color:#d32f2f">'+_esc(parsedDoc.parseFailureReason)+'</span>');
      }
      if(fp){
        if(fp.hasSemanticEmbedding!=null) html += _row('Embedding', fp.hasSemanticEmbedding
          ? '<span style="color:#43a047">✓ stored</span>'
          : '<span style="color:#607d8b">none</span>');
        if(typeof fp.requirementDensity === 'number') html += _row('Req. density', fp.requirementDensity.toFixed(3)+' /section');
      }
      if(!file && !parsedDoc) html += '<tr><td colspan="2" style="color:#607d8b;font-style:italic">Metadata not available</td></tr>';
      html += '</tbody></table></div>';

      // ── 2. Extracted Headings ─────────────────────────────────────────────────
      if(parsedDoc && parsedDoc.headings && parsedDoc.headings.length > 0){
        html += '<div class="modal-section"><h4>Extracted Headings ('+parsedDoc.headings.length+')</h4>';
        html += '<div class="modal-headings">';
        parsedDoc.headings.forEach(function(h){
          var indent = (h.level - 1) * 16;
          var size   = h.level===1 ? '1em'  : h.level===2 ? '.9em' : '.82em';
          var weight = h.level===1 ? '600'  : '400';
          var col    = h.level===1 ? '#e4e6eb' : h.level===2 ? '#c0c4cc' : '#a0a4ab';
          var num    = h.numbering ? '<span style="color:#607d8b;margin-right:.4em;font-size:.82em">'+_esc(h.numbering)+'</span>' : '';
          var toks   = h.approximateTokens ? ' <span style="color:#607d8b;font-size:.72em">~'+h.approximateTokens+' tok</span>' : '';
          html += '<div style="padding:.22rem 0 .22rem '+indent+'px;border-bottom:1px solid rgba(255,255,255,.04);font-size:'+size+';font-weight:'+weight+';color:'+col+'">'
            +num+_esc(h.text)+toks+'</div>';
        });
        html += '</div></div>';
      }

      // ── 3. Date Signals ───────────────────────────────────────────────────────
      if(parsedDoc && parsedDoc.dateSignals){
        var ds = parsedDoc.dateSignals;
        html += '<div class="modal-section"><h4>Date Signals</h4><table class="modal-table"><tbody>';
        if(ds.bestDate)             html += _row('Best date', '<strong style="color:#ff6b35">'+_esc(ds.bestDate)+'</strong>');
        if(ds.documentInternalDate) html += _row('Internal date', _esc(ds.documentInternalDate)
          +(ds.internalDateSource?' <span style="color:#a0a4ab;font-size:.8em">via '+_esc(ds.internalDateSource)+'</span>':''));
        if(ds.mtime)                html += _row('File mtime', _esc(ds.mtime)
          +' '+(ds.mtimeReliable ? '<span style="color:#43a047;font-size:.78em">reliable</span>' : '<span style="color:#607d8b;font-size:.78em">unreliable</span>'));
        if(parsedDoc.dateSource)    html += _row('Date source', _esc(parsedDoc.dateSource));
        html += '</tbody></table></div>';
      }

      // ── 4. RAG / Chunk Analysis ───────────────────────────────────────────────
      if(parsedDoc && (parsedDoc.recommendedChunkStrategy || parsedDoc.requirementQuality)){
        html += '<div class="modal-section"><h4>RAG Analysis</h4><table class="modal-table"><tbody>';
        if(parsedDoc.recommendedChunkStrategy){
          html += _row('Chunk strategy', '<strong style="color:#ff6b35">'+_esc(parsedDoc.recommendedChunkStrategy)+'</strong>');
          if(parsedDoc.chunkStrategyReasoning){
            var cr = parsedDoc.chunkStrategyReasoning;
            html += _row('Confidence', _pct(cr.confidence));
            if(cr.signals){
              var sigParts = [];
              var sigKeys = Object.keys(cr.signals);
              for(var i=0;i<sigKeys.length;i++){
                var k = sigKeys[i];
                var v = cr.signals[k];
                sigParts.push(_esc(k.replace(/([A-Z])/g,' $1').toLowerCase())+': <strong>'+_esc(String(v))+'</strong>');
              }
              if(sigParts.length) html += _row('Signals', sigParts.join(' &bull; '));
            }
          }
        }
        if(parsedDoc.requirementQuality){
          var rq = parsedDoc.requirementQuality;
          html += _row('Req. quality',
            (rq.confirmed ? '<span style="color:#43a047">'+rq.confirmed+' confirmed</span> ' : '')
            +(rq.negated  ? '<span style="color:#607d8b">'+rq.negated+' negated</span> '    : '')
            +(rq.uncertain? '<span style="color:#ff9800">'+rq.uncertain+' uncertain</span> ' : '')
            +(rq.raw      ? '<span style="color:#a0a4ab">'+rq.raw+' raw</span>'             : '')
            || '<span style="color:#607d8b">none</span>');
          if(parsedDoc.requirementMetadataReliable!=null)
            html += _row('Req. metadata', parsedDoc.requirementMetadataReliable
              ? '<span style="color:#43a047">✓ reliable</span>'
              : '<span style="color:#607d8b">unreliable</span>');
        }
        html += '</tbody></table></div>';
      }

      // ── 5. Version Pair Matches ───────────────────────────────────────────────
      if(vps && vps.length > 0){
        var CONF_COL = {HIGH:'#43a047', MEDIUM:'#ff9800', LOW:'#607d8b', NOT_A_PAIR:'#d32f2f'};
        html += '<div class="modal-section"><h4>Version Pair Matches ('+vps.length+')</h4>';
        html += '<table class="modal-table"><thead><tr>'
          +'<th>Score</th><th>Conf.</th><th>Likely newer</th><th>Other document</th><th>Signals</th>'
          +'</tr></thead><tbody>';
        vps.forEach(function(vp){
          var thisPath  = file ? file.path : '';
          var otherPath = vp.docA === thisPath ? vp.docB : vp.docA;
          var otherFile = _byPath.get(otherPath);
          var otherName = otherFile ? otherFile.filename : (otherPath.split('/').pop()||otherPath);
          var newerSide = vp.likelyNewer==='A' ? vp.docA : vp.likelyNewer==='B' ? vp.docB : '';
          var newerText = newerSide===thisPath
            ? '<span style="color:#43a047">▶ this doc</span>'
            : newerSide===otherPath
              ? '◀ '+_esc(otherName.length>22?otherName.slice(0,20)+'…':otherName)
              : '<span style="color:#607d8b">?</span>';
          var scoreBg = vp.score>=10?'#43a047':vp.score>=7?'#8bc34a':vp.score>=5?'#ff9800':'#607d8b';
          var cc = CONF_COL[vp.confidence]||'#607d8b';
          var sigHtml = '—';
          if(vp.signals){
            var s = vp.signals;
            sigHtml = '<div style="font-size:.71em;line-height:2;font-family:monospace">'
              +'fn-sim: <b>'+(typeof s.filenameNormalizedSimilarity==='number'?s.filenameNormalizedSimilarity.toFixed(2):'—')+'</b> &bull; '
              +'struct: <b style="color:'+(s.structuralMatch?'#43a047':'#607d8b')+'">'+(s.structuralMatch?'✓':'✗')+'</b> &bull; '
              +'mhash: <b>'+(typeof s.headingMinHashJaccard==='number'?s.headingMinHashJaccard.toFixed(3):'—')+'</b> &bull; '
              +'cos: <b style="color:#1e88e5">'+(typeof s.semanticCosineSimilarity==='number'?s.semanticCosineSimilarity.toFixed(4):'—')+'</b>'
              +(s.modifiedDateDeltaDays!=null?' &bull; Δdate: <b>'+s.modifiedDateDeltaDays+'d</b>':'')
              +(s.sameDirectory!=null?' &bull; same-dir: <b style="color:'+(s.sameDirectory?'#43a047':'#607d8b')+'">'+(s.sameDirectory?'✓':'✗')+'</b>':'')
              +'</div>';
          }
          html += '<tr>'
            +'<td><span class="score-badge" style="background:'+scoreBg+'">'+vp.score+'</span></td>'
            +'<td style="color:'+cc+';font-weight:600;font-size:.85em">'+_esc(vp.confidence)+'</td>'
            +'<td style="font-size:.82em">'+newerText+'</td>'
            +'<td><a class="doc-link" href="#" data-path="'+_esc(otherPath)+'">'+_esc(otherName.length>38?otherName.slice(0,36)+'…':otherName)+'</a>'
            +(vp.versionPairFlag?' <span class="flag-badge">TEMPLATE?</span>':'')+'</td>'
            +'<td>'+sigHtml+'</td>'
            +'</tr>';
        });
        html += '</tbody></table></div>';
      }

      // ── 6. Requirements ───────────────────────────────────────────────────────
      if(reqs.length){
        var TC={'MUSS':'#d32f2f','SOLL':'#ff6b35','KANN':'#1e88e5','DEKLARATIV':'#43a047','INFORMATIV':'#607d8b'};
        html += '<div class="modal-section"><h4>Requirements ('+reqs.length+')</h4>';
        html += '<table class="modal-table"><thead><tr><th>Type</th><th>Category</th><th style="text-align:center">Safety</th><th>Linked norm</th><th>Section heading</th></tr></thead><tbody>';
        reqs.forEach(function(r){
          var col = TC[r.type]||'#607d8b';
          var safety = r.isSafetyRelevant ? '<span style="color:#d32f2f" title="Safety-critical">⚠</span>' : '';
          var hdg  = r.sectionHeading ? _esc(r.sectionHeading.slice(0,80)) : '—';
          var norm = r.linkedNorm ? '<span style="font-size:.78em;font-family:monospace">'+_esc(r.linkedNorm)+'</span>' : '—';
          html += '<tr>'
            +'<td><span class="req-type-badge" style="background:'+col+'">'+r.type+'</span></td>'
            +'<td style="font-size:.85em">'+_esc(r.category||'—')+'</td>'
            +'<td style="text-align:center">'+safety+'</td>'
            +'<td>'+norm+'</td>'
            +'<td style="font-size:.8em;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_esc(r.sectionHeading||'')+'">'+hdg+'</td>'
            +'</tr>';
        });
        html += '</tbody></table></div>';
      }

      // ── 7. References ─────────────────────────────────────────────────────────
      if(refs.length){
        html += '<div class="modal-section"><h4>References ('+refs.length+')</h4>';
        html += '<table class="modal-table"><thead><tr><th>Type</th><th>Reference</th><th>Resolution</th><th>Section context</th></tr></thead><tbody>';
        var shown = refs.slice(0,60);
        shown.forEach(function(r){
          var col = (r.resolutionMethod==='exact'||r.resolutionMethod==='fuzzy') ? '#43a047'
                  : r.resolutionMethod==='external_norm' ? '#1e88e5' : '#d32f2f';
          var section = r.sectionContext ? _esc(r.sectionContext.slice(0,50)) : '—';
          html += '<tr>'
            +'<td style="font-size:.75em;color:#a0a4ab">'+_esc(r.type)+'</td>'
            +'<td style="font-family:monospace;font-size:.82em">'+_esc(r.normalized||r.rawText)+'</td>'
            +'<td style="color:'+col+';font-size:.82em;white-space:nowrap">'+_esc(r.resolutionMethod||'unresolved')+'</td>'
            +'<td style="font-size:.78em;color:#a0a4ab;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+_esc(r.sectionContext||'')+'">'+section+'</td>'
            +'</tr>';
        });
        if(refs.length>60) html += '<tr><td colspan="4" style="color:#607d8b;font-style:italic;font-size:.8em">…and '+(refs.length-60)+' more</td></tr>';
        html += '</tbody></table></div>';
      }

      return html;
    }

    window.showDocDetail = function(pathOrId){
      var file      = _byPath.get(pathOrId) || _byId.get(pathOrId);
      var docId     = (file && file.id)   ? file.id   : pathOrId;
      var filePath  = (file && file.path) ? file.path : '';
      var parsedDoc = _parsed.get(docId);
      var reqs = _reqs[docId]       || [];
      var refs = _refs[docId]       || [];
      var vps  = _vpById[docId] || [];
      var fp   = _fpById.get(docId);
      var title = (file && file.filename)
        || (pathOrId.indexOf('/')>=0 ? pathOrId.split('/').pop() : pathOrId);
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML = _buildModal(file, parsedDoc, reqs, refs, vps, fp);
      var modal = document.getElementById('doc-modal');
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
      modal.focus && modal.focus();
    };

    window.closeDocModal = function(){
      document.getElementById('doc-modal').style.display = 'none';
      document.body.style.overflow = '';
    };

    document.getElementById('doc-modal').addEventListener('click', function(e){
      if(e.target === this) window.closeDocModal();
    });

    // Delegated click handler for all .doc-link elements (set data-path or data-doc-id)
    document.addEventListener('click', function(e){
      var link = e.target && e.target.closest && e.target.closest('.doc-link');
      if(link){
        e.preventDefault();
        var id = link.dataset.path || link.dataset.docId || '';
        if(id) window.showDocDetail(id);
      }
    });

    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && document.getElementById('doc-modal').style.display!=='none'){
        window.closeDocModal();
      }
    });
  })();
  </script>

  <!-- Chart.js Library -->
  ${chartJsTag}
  <script>
    // Global table search — wire up all .table-search inputs (skips #req-search which has its own handler)
    document.addEventListener('DOMContentLoaded', function() {
      document.querySelectorAll('.table-search').forEach(function(input) {
        const tableId = input.dataset.table;
        const countEl = input.closest('.table-search-wrap')?.querySelector('.table-search-count');
        const table = document.getElementById(tableId);
        if (!table) return;

        function filterTable() {
          const q = input.value.toLowerCase().trim();
          const rows = table.querySelectorAll('tbody tr');
          let visible = 0;
          rows.forEach(function(row) {
            const text = row.textContent.toLowerCase();
            const show = !q || text.includes(q);
            row.classList.toggle('row-hidden', !show);
            if (show) visible++;
          });
          if (countEl) {
            countEl.textContent = q ? visible + ' of ' + rows.length + ' rows' : rows.length + ' rows';
          }
        }

        input.addEventListener('input', filterTable);
        // Initialize count
        const rows = table.querySelectorAll('tbody tr').length;
        if (countEl) countEl.textContent = rows + ' rows';
      });
    });

    // ── Quick-nav: build from section h2s, highlight on scroll ───────────────
    (function() {
      var nav = document.getElementById('quick-nav');
      if (!nav) return;
      var sections = Array.from(document.querySelectorAll('.container > section'));
      if (sections.length === 0) return;

      sections.forEach(function(sec, i) {
        var h2 = sec.querySelector('h2');
        if (!h2) return;
        sec.id = sec.id || ('sec-' + i);
        var a = document.createElement('a');
        a.className = 'qnav-link';
        a.href = '#' + sec.id;
        a.textContent = h2.textContent.trim().replace(/\s*&.*$/, ''); // trim "& subtitle"
        a.title = h2.textContent.trim();
        a.addEventListener('click', function(e) {
          e.preventDefault();
          sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.appendChild(a);
      });

      var links = Array.from(nav.querySelectorAll('.qnav-link'));

      function updateActive() {
        var scrollY = window.scrollY + 120;
        var current = sections[0];
        sections.forEach(function(sec) {
          if (sec.offsetTop <= scrollY) current = sec;
        });
        links.forEach(function(link) {
          link.classList.toggle('qnav-active', link.getAttribute('href') === '#' + current.id);
        });
      }

      window.addEventListener('scroll', updateActive, { passive: true });
      updateActive();
    })();
  </script>
</body>
</html>`;
}
