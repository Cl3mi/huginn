#!/usr/bin/env bun
// CLI entry point: lightweight HTTP server for browsing multiple reports
// Usage: bun run dashboard:serve --port 3000 --reports ./reports [--watch]

interface CliArgs {
  port: number;
  reportsDir: string;
  watch: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  let port = 3000;
  let reportsDir = './reports';
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--reports' && i + 1 < args.length) {
      reportsDir = args[i + 1];
      i++;
    } else if (args[i] === '--watch') {
      watch = true;
    }
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('❌ Invalid port number. Must be between 1 and 65535.');
    process.exit(1);
  }

  return { port, reportsDir, watch };
}

async function main() {
  const { port, reportsDir, watch } = parseArgs();

  console.log(`📊 Huginn Dashboard Server (Phase 4 stub)`);
  console.log(`   Port: ${port}`);
  console.log(`   Reports: ${reportsDir}`);
  console.log(`   Watch mode: ${watch ? 'enabled' : 'disabled'}`);
  console.log(`\n   Implementation planned for Phase 4 of dashboard feature.`);
  console.log(`   For now, use: bun run dashboard:generate <report.json>`);
}

main();
