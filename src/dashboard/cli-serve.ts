#!/usr/bin/env bun
// CLI entry point: lightweight HTTP server for browsing multiple reports
// Usage: bun run dashboard:serve [--port 3000] [--reports ./reports] [--watch]

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { renderHtml } from './cli-generate.js';

interface CliArgs {
  port: number;
  reportsDir: string;
  watch: boolean;
}

interface ReportMeta {
  filename: string;
  scanId: string;
  timestamp: string;
  totalFiles: number;
  parsedFiles: number;
  mqScore: number | null;
  sizeKb: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let port = 3000;
  let reportsDir = './reports';
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && i + 1 < args.length) {
      port = parseInt(args[++i] ?? '3000', 10);
    } else if ((args[i] === '--reports' || args[i] === '-r') && i + 1 < args.length) {
      reportsDir = args[++i] ?? reportsDir;
    } else if (args[i] === '--watch' || args[i] === '-w') {
      watch = true;
    }
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('❌ Invalid port. Must be 1-65535.');
    process.exit(1);
  }

  return { port, reportsDir, watch };
}

function listReports(dir: string): ReportMeta[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.json') && f.startsWith('scan-report') && !f.includes('human') && !f.includes('narrative'),
  );

  const results: ReportMeta[] = [];
  for (const filename of files) {
    const path = join(dir, filename);
    try {
      const raw = readFileSync(path, 'utf-8');
      const report = JSON.parse(raw) as Record<string, unknown>;
      const summary = (report.summary as Record<string, unknown>) || {};
      const st = statSync(path);
      results.push({
        filename,
        scanId: (report.scanId as string) || filename,
        timestamp: (report.timestamp as string) || '',
        totalFiles: (summary.totalFiles as number) || 0,
        parsedFiles: (summary.parsedFiles as number) || 0,
        mqScore: (summary.mqScore as number | null) ?? null,
        sizeKb: Math.round(st.size / 1024),
      });
    } catch {
      // skip unparseable files
    }
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function generateReportHtml(reportPath: string): Promise<string> {
  return renderHtml(reportPath, true);
}

function buildIndexPage(reports: ReportMeta[], reportsDir: string): string {
  const rows = reports
    .map((r) => {
      const mqColor = r.mqScore === null ? '#607d8b' : r.mqScore >= 66 ? '#43a047' : r.mqScore >= 33 ? '#ff6b35' : '#d32f2f';
      const mqDisplay = r.mqScore !== null ? r.mqScore.toString() : '—';
      const date = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
      return `<tr>
        <td><a href="/report/${encodeURIComponent(r.filename)}">${r.scanId}</a></td>
        <td>${date}</td>
        <td>${r.parsedFiles}/${r.totalFiles}</td>
        <td><span style="color:${mqColor};font-weight:700;font-family:monospace">${mqDisplay}</span></td>
        <td style="color:#a0a4ab">${r.sizeKb} KB</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Huginn Dashboard — Report Browser</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { background:#0f1419; color:#e4e6eb; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:2rem }
    h1 { font-family:"IBM Plex Mono","Fira Code",monospace; color:#ff6b35; margin-bottom:.5rem }
    p.subtitle { color:#a0a4ab; margin-bottom:2rem }
    table { width:100%; border-collapse:collapse; font-size:.9em }
    th { padding:.75rem; text-align:left; border-bottom:2px solid #ff6b35; color:#a0a4ab; font-family:monospace; text-transform:uppercase; font-size:.8em; letter-spacing:1px }
    td { padding:.75rem; border-bottom:1px solid #2a3038 }
    tr:hover td { background:#1a1f26 }
    a { color:#ff6b35; text-decoration:none }
    a:hover { text-decoration:underline }
    .empty { color:#607d8b; font-style:italic; padding:2rem; text-align:center }
    .dir { color:#a0a4ab; font-family:monospace; font-size:.85em; margin-bottom:1.5rem; padding:.5rem; background:#1a1f26; border-left:3px solid #2a3038 }
  </style>
</head>
<body>
  <h1>Huginn Dashboard</h1>
  <p class="subtitle">Document Intelligence Report Browser</p>
  <div class="dir">Reports directory: ${resolve(reportsDir)}</div>
  ${
    reports.length === 0
      ? '<p class="empty">No scan reports found. Run the scanner to generate reports.</p>'
      : `<table>
    <thead><tr><th>Scan ID</th><th>Timestamp</th><th>Files</th><th>MQ</th><th>Size</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</body>
</html>`;
}

async function main() {
  const { port, reportsDir, watch } = parseArgs();
  const resolvedDir = resolve(reportsDir);

  console.log(`\n📊 Huginn Dashboard Server`);
  console.log(`   Reports: ${resolvedDir}`);
  console.log(`   Watch mode: ${watch ? 'enabled' : 'disabled'}\n`);

  // Cache generated HTML in memory (invalidated on watch)
  const htmlCache = new Map<string, string>();

  if (watch) {
    // Simple polling watch — clear cache every 5s
    setInterval(() => htmlCache.clear(), 5000);
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      // Index page
      if (path === '/' || path === '/index.html') {
        const reports = listReports(reportsDir);
        return new Response(buildIndexPage(reports, reportsDir), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // API: list reports as JSON
      if (path === '/api/reports') {
        const reports = listReports(reportsDir);
        return new Response(JSON.stringify(reports, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Individual report HTML
      if (path.startsWith('/report/')) {
        const filename = path.slice('/report/'.length);

        // Guard against path traversal
        if (filename.includes('..') || filename.includes('/')) {
          return new Response('Bad request', { status: 400 });
        }

        const reportPath = join(resolvedDir, filename);
        if (!existsSync(reportPath)) {
          return new Response('Report not found', { status: 404 });
        }

        const cacheKey = reportPath;
        if (!htmlCache.has(cacheKey)) {
          try {
            const html = await generateReportHtml(reportPath);
            htmlCache.set(cacheKey, html);
          } catch (err) {
            console.error(`Error generating report ${filename}:`, err);
            return new Response('Error generating dashboard', { status: 500 });
          }
        }

        return new Response(htmlCache.get(cacheKey)!, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // API: serve raw report JSON
      if (path.startsWith('/api/report/')) {
        const filename = path.slice('/api/report/'.length);
        if (filename.includes('..') || filename.includes('/')) {
          return new Response('Bad request', { status: 400 });
        }
        const reportPath = join(resolvedDir, filename);
        if (!existsSync(reportPath)) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(readFileSync(reportPath, 'utf-8'), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`✓ Server running at http://localhost:${server.port}`);
  console.log(`  http://localhost:${server.port}/           → Report list`);
  console.log(`  http://localhost:${server.port}/api/reports → JSON report index\n`);
  console.log('Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('❌ Server error:', err);
  process.exit(4);
});
