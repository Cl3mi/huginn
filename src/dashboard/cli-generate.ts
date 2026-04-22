#!/usr/bin/env bun
// CLI entry point: generates static HTML from JSON report
// Usage: bun run dashboard:generate <report.json> [--output <file.html>]

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { generateHtmlTemplate } from './html-template.js';
import { validateReport } from './lib/validate.js';
import * as components from './components/index.js';

interface CliArgs {
  reportPath: string;
  outputPath: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: bun run dashboard:generate <report.json> [--output <file.html>]');
    process.exit(1);
  }

  const reportPath = args[0];
  let outputPath = reportPath.replace('.json', '.html');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      outputPath = args[i + 1];
    }
  }

  return { reportPath, outputPath };
}

async function main() {
  const { reportPath, outputPath } = parseArgs();

  try {
    // Read and validate JSON
    console.log(`📖 Reading report: ${reportPath}`);
    const jsonRaw = readFileSync(reportPath, 'utf-8');
    const reportData = JSON.parse(jsonRaw);

    const validation = validateReport(reportData);
    if (!validation.valid) {
      console.error('❌ Report validation failed:');
      validation.errors.forEach(err => console.error(`   - ${err}`));
      process.exit(2);
    }

    console.log('✓ Report validation passed');

    // Render components
    console.log('🎨 Rendering dashboard components...');
    const header = await components.renderHeader(reportData);
    const kpiCards = await components.renderKpiCards(reportData);
    const qualityGauge = await components.renderQualityGauge(reportData);
    const docDistribution = await components.renderDocumentDistribution(reportData);
    const versionAnalysis = await components.renderVersionAnalysis(reportData);
    const requirementsLandscape = await components.renderRequirementsLandscape(reportData);
    const referenceGraph = await components.renderReferenceGraph(reportData);
    const parseHealth = await components.renderParseHealth(reportData);
    const ragDecisions = await components.renderRagDecisions(reportData);
    const footer = await components.renderFooter(reportData);

    const bodyContent = [
      header,
      kpiCards,
      qualityGauge,
      docDistribution,
      versionAnalysis,
      requirementsLandscape,
      referenceGraph,
      parseHealth,
      ragDecisions,
      footer,
    ].join('\n');

    // Generate HTML with embedded JSON
    const html = generateHtmlTemplate(jsonRaw, bodyContent);

    // Write file
    const absolutePath = resolve(outputPath);
    writeFileSync(absolutePath, html, 'utf-8');

    const sizeKb = (html.length / 1024).toFixed(1);
    console.log(`✓ Dashboard generated: ${absolutePath}`);
    console.log(`  Size: ${sizeKb} KB`);
    console.log(`\n  Open in browser: file://${absolutePath}`);

    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`❌ Error: ${error.message}`);
    } else {
      console.error('❌ Unknown error occurred');
    }
    process.exit(3);
  }
}

main();
