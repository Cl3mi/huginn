#!/usr/bin/env bun
// CLI entry point: generates static HTML from JSON report
// Usage: bun run dashboard:generate <report.json> [--output <file.html>] [--no-inline-assets]

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { generateHtmlTemplate } from './html-template.js';
import { validateReport } from './lib/validate.js';
import * as components from './components/index.js';

interface CliArgs {
  reportPath: string;
  outputPath: string;
  inlineAssets: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: bun run dashboard:generate <report.json> [--output <file.html>] [--no-inline-assets]');
    process.exit(1);
  }

  const reportPath = args[0] ?? '';
  let outputPath = reportPath.replace(/\.json$/, '.html');
  let inlineAssets = true;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--output' || args[i] === '-o') && i + 1 < args.length) {
      outputPath = args[++i] ?? outputPath;
    } else if (args[i] === '--no-inline-assets') {
      inlineAssets = false;
    }
  }

  return { reportPath, outputPath, inlineAssets };
}

function loadChartJs(): string | undefined {
  // Resolve path relative to this file's location
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, '../../node_modules/chart.js/dist/chart.umd.min.js'),
    join(process.cwd(), 'node_modules/chart.js/dist/chart.umd.min.js'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8');
    }
  }

  console.warn('⚠ chart.js not found in node_modules — falling back to CDN (requires internet)');
  return undefined;
}

export async function renderHtml(reportPath: string, inlineAssets = true): Promise<string> {
  const jsonRaw = readFileSync(reportPath, 'utf-8');
  const reportData = JSON.parse(jsonRaw);

  const validation = validateReport(reportData);
  if (!validation.valid) {
    throw new Error(`Report validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const [header, kpiCards, qualityGauge, docDistribution, versionAnalysis, requirementsLandscape, referenceGraph, parseHealth, ragDecisions, footer] =
    await Promise.all([
      components.renderHeader(reportData),
      components.renderKpiCards(reportData),
      components.renderQualityGauge(reportData),
      components.renderDocumentDistribution(reportData),
      components.renderVersionAnalysis(reportData),
      components.renderRequirementsLandscape(reportData),
      components.renderReferenceGraph(reportData),
      components.renderParseHealth(reportData),
      components.renderRagDecisions(reportData),
      components.renderFooter(reportData),
    ]);

  const bodyContent = [header, kpiCards, qualityGauge, docDistribution, versionAnalysis, requirementsLandscape, referenceGraph, parseHealth, ragDecisions, footer].join(
    '\n',
  );

  const chartJsSource = inlineAssets ? loadChartJs() : undefined;
  return generateHtmlTemplate(jsonRaw, bodyContent, chartJsSource);
}

export async function generateDashboard(
  reportPath: string,
  outputPath: string,
  inlineAssets = true,
): Promise<{ html: string; sizeKb: string }> {
  const html = await renderHtml(reportPath, inlineAssets);
  const sizeKb = (html.length / 1024).toFixed(1);
  writeFileSync(resolve(outputPath), html, 'utf-8');
  return { html, sizeKb };
}

async function main() {
  const { reportPath, outputPath, inlineAssets } = parseArgs();

  try {
    console.log(`📖 Reading report: ${reportPath}`);
    console.log(`🎨 Rendering dashboard (${inlineAssets ? 'offline/inline' : 'CDN'} mode)...`);

    const { sizeKb } = await generateDashboard(reportPath, outputPath, inlineAssets);

    const absolutePath = resolve(outputPath);
    console.log(`✓ Dashboard generated: ${absolutePath}`);
    console.log(`  Size: ${sizeKb} KB${inlineAssets ? ' (includes Chart.js)' : ''}`);
    console.log(`\n  Open in browser: file://${absolutePath}`);

    process.exit(0);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(error instanceof Error && error.message.startsWith('Report validation') ? 2 : 3);
  }
}

main();
