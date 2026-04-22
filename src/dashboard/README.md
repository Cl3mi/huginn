# Huginn Dashboard

Local, offline-first visualization of Huginn document intelligence scan reports. Self-contained HTML or lightweight server—no cloud dependencies, designed for on-premise clients.

## Quick Start

### Generate Dashboard (Static HTML)

```bash
# Basic usage
bun run dashboard:generate ./reports/scan-report-2026-04-22.json

# With custom output
bun run dashboard:generate ./reports/scan-report-2026-04-22.json --output ./my-report.html
```

This generates a single `.html` file with:
- Embedded JSON report data (no external requests)
- Inline CSS (dark industrial theme)
- All charts and visualizations
- Suitable for email, archival, client handoff

### Serve Multiple Reports (Local Server)

```bash
# Start server on http://localhost:3000
bun run dashboard:serve --port 3000 --reports ./reports

# With watch mode (regenerate on JSON change)
bun run dashboard:serve --port 3000 --reports ./reports --watch
```

## Architecture

### Technology Stack
- **Chart.js** (40 KB) — bar, radar, doughnut, line charts
- **D3** (minimal subset) — version chain trees, reference networks
- **Vanilla TypeScript** — no framework overhead
- **Inline CSS** — self-contained, printable
- **Bun HTTP** (server mode only) — lightweight, fast

### Design Aesthetic
- **Dark theme** `#0f1419` (carbon) — reduces eye strain, fits manufacturing context
- **Industrial fonts** — IBM Plex Mono (headings), Fira Code (tables)
- **Safety colors** — Orange `#ff6b35`, Red `#d32f2f`, Green `#43a047`
- **Monospace accents** — technical, automotive-appropriate

### File Structure
```
src/dashboard/
├── cli-generate.ts              # Main: JSON → HTML
├── cli-serve.ts                 # Server: browse multiple reports
├── html-template.ts             # CSS skeleton + Chart.js embed
├── components/
│   ├── header.ts                # Metadata banner
│   ├── kpi-cards.ts             # Summary statistics
│   ├── quality-gauge.ts         # MQ radial chart
│   ├── document-distribution.ts # Metadata charts
│   ├── version-analysis.ts      # Version pair viz
│   ├── requirements-landscape.ts# Requirement breakdown
│   ├── reference-graph.ts       # Reference network
│   ├── parse-health.ts          # Parse success + OCR
│   ├── rag-decisions.ts         # Consistency checks
│   └── footer.ts                # Footer + export
├── lib/
│   ├── chart-config.ts          # Theme + Chart.js defaults
│   ├── validate.ts              # JSON validation
│   ├── formatters.ts            # Display formatting
│   ├── color-scale.ts           # Score → color
│   └── d3-helpers.ts            # D3 utilities
└── _fixtures/
    └── sample-reports.ts        # Test data
```

## Implementation Phases

### Phase 0: Setup ✓ COMPLETED
- Directory structure created
- Dependencies added (Chart.js, D3)
- Dark theme CSS framework
- CLI scaffolding
- Validation and formatters
- Test fixtures

### Phase 1: Static Export (NEXT)
- Implement KPI cards with real styling
- Proper header/footer rendering
- Embed Chart.js library
- Test with sample reports

### Phase 2-6: Additional Phases
See `PHASE_STATUS.md` for detailed tracking.

## Testing

### Smoke Test (Phase 0-1)
```bash
# Generate dashboard from test report
bun run dashboard:generate /tmp/test-report.json --output /tmp/test.html

# Open in browser
open /tmp/test.html  # macOS
xdg-open /tmp/test.html  # Linux
```

### Verify Output
- [ ] HTML loads without console errors
- [ ] Dark theme visible
- [ ] Header displays scan ID
- [ ] 4 KPI cards show correct values
- [ ] Responsive on mobile (Ctrl+Shift+M)
- [ ] File size < 200 KB for typical report

## Dashboard Sections

1. **Header** — Scan ID, timestamp, MQ score banner
2. **Executive Summary** — 4 KPI cards (files, pairs, refs, reqs)
3. **Data Quality** — MQ gauge chart + components
4. **Document Distribution** — Metadata charts
5. **Version Pairs** — Clustering analysis + tree
6. **Requirements** — Type/category breakdown
7. **References** — Network visualization
8. **Parse Health** — Success rates + OCR status
9. **RAG Decisions** — Consistency checks
10. **Footer** — Exports + metadata

## Key Features

✅ **Offline-first** — No CDN, no cloud APIs
✅ **Self-contained** — Single HTML file (optional JSON sidecar)
✅ **Email-friendly** — Embeddable in Outlook, Gmail
✅ **Professional** — Industrial aesthetic, automotive-appropriate
✅ **Responsive** — Mobile-friendly, printable
✅ **Type-safe** — Full TypeScript strict mode
✅ **Fast** — Rendered in <100ms, loads instantly

## Constraints

- **String length guard** — max 120 chars per field (reuses `clamp()`, `sanitizeReport()` from Phase 8)
- **Minimal dependencies** — Chart.js only at runtime
- **Embedding only** — No external requests or CDNs
- **UTF-8 safe** — Handles German umlauts and multi-language content

## Future Extensions

- PDF export (Playwright) — Phase 5
- Theme toggle (dark/light) — Phase 5
- Table search/filter — Phase 5
- Multi-report comparison — Phase 4
- Trend analysis (time-series) — Beyond Phase 6
- Annotations/notes (localStorage) — Beyond Phase 6

## Troubleshooting

### "Cannot find module 'chart.js'"
```bash
bun install
```

### Generated HTML shows "N/A" or blank sections
- Check JSON report validation: `bun run dashboard:generate bad.json`
- Verify required fields in report: `scanId`, `summary`, `parsed`, etc.
- See `lib/validate.ts` for expected structure

### Chart doesn't render
- Phase 1-3 features still in implementation
- KPI cards (Phase 1) working; advanced charts (Phases 2-3) coming soon

## Contributing

When adding new components:
1. Create `components/new-component.ts`
2. Export async function returning HTML string
3. Import in `components/index.ts`
4. Call from `cli-generate.ts` in bodyContent
5. Test with sample report fixture
6. Document in `PHASE_STATUS.md`

## License

Same as Huginn parent project.
