# Dashboard Implementation Status

## Phase 0: Setup ✓ COMPLETED
- [x] Create `/src/dashboard/` directory structure
- [x] Add Chart.js + D3 to `package.json`
- [x] Add `dashboard:generate` and `dashboard:serve` scripts
- [x] Create `lib/chart-config.ts` with dark theme defaults (colors, fonts, Chart.js config)
- [x] Create `lib/validate.ts` for JSON report validation
- [x] Create `lib/formatters.ts` for display utilities
- [x] Create `components/index.ts` with component signatures (stubs)
- [x] Create `html-template.ts` with CSS framework and HTML skeleton
- [x] Create `cli-generate.ts` main entry point
- [x] Create `cli-serve.ts` server entry point (Phase 4 stub)
- [x] Create `_fixtures/sample-reports.ts` test data
- [x] Update `CLAUDE.md` with dashboard architecture documentation

## Phase 1: Static Export Foundation (NEXT)
**Objective:** Generate a basic HTML file from JSON report with KPI cards visible

### Tasks:
- [ ] Test `cli-generate.ts` with fixture reports
  ```bash
  # Generate sample.json from BASIC_REPORT
  cat > /tmp/test-report.json << 'EOF'
  { /* BASIC_REPORT from _fixtures */ }
  EOF
  bun run dashboard:generate /tmp/test-report.json --output /tmp/test.html
  ```
- [ ] Verify HTML loads in browser without errors
- [ ] Implement `components/header.ts` properly (render function)
- [ ] Implement `components/kpi-cards.ts` with styled output
- [ ] Implement `components/footer.ts`
- [ ] Embed Chart.js library inline in HTML template
- [ ] Create simple test: `npm run dashboard:test` (or manual test)
- [ ] Document how to test: "Open generated HTML in browser"

### Files Modified in Phase 1:
- `src/dashboard/components/header.ts` — full implementation
- `src/dashboard/components/kpi-cards.ts` — full implementation
- `src/dashboard/components/footer.ts` — full implementation
- `src/dashboard/html-template.ts` — embed Chart.js + initialize charts
- `src/dashboard/cli-generate.ts` — may need minor adjustments

### Exit Criteria:
- Generated HTML opens in browser without console errors
- KPI cards display correct values from sample report
- CSS dark theme visible and responsive
- File size < 200 KB for typical report

---

## Phase 2: Core Charts (AFTER PHASE 1)
**Objective:** Implement bar, radar, doughnut charts for distributions and quality

### Components to Implement:
- `components/quality-gauge.ts` — radial gauge (Chart.js doughnut)
- `components/document-distribution.ts` — 4 charts (bar, radar, bar, donut)
- `components/parse-health.ts` — success rate + scanned PDF bar
- `components/requirements-landscape.ts` — type/category breakdown + safety badge

### Key Decisions:
- Chart.js initialization in template (not components)
- Each component returns Canvas `<canvas id="..."></canvas>` + initialization code in footer script
- Colors from `chart-config.ts`

---

## Phase 3: Advanced Visualizations (AFTER PHASE 2)
**Objective:** D3 trees and network graphs for complex relationships

### Components to Implement:
- `components/version-analysis.ts` — histogram + HIGH pairs table + D3 version chain tree
- `components/reference-graph.ts` — top norms bar + D3 network visualization

### Dependencies:
- D3 v7 (already in package.json)
- Custom D3 helpers: `lib/d3-helpers.ts`

---

## Phase 4: Server Mode (AFTER PHASE 3)
**Objective:** HTTP server for browsing multiple reports

### Implementation:
- `cli-serve.ts` — full Bun HTTP server
- Report listing endpoint
- Multi-report comparison (optional)
- Watch mode for regenerating HTML on JSON change

---

## Phase 5: Polish (AFTER PHASE 4)
**Objective:** Production-ready features

### Features:
- PDF export (Playwright)
- Print-friendly CSS (already in template)
- Dark/light theme toggle
- Search/filter for tables
- Performance: minify/compress JSON in HTML

---

## Phase 6: Integration & Testing (FINAL)
**Objective:** Integrate with scanner pipeline

### Tasks:
- Update `src/index.ts` to optionally generate dashboard
- Add `--dashboard` flag to scanner CLI
- Write fixtures for all report types
- Performance testing with large reports
- Documentation in README.md

---

## Quick Reference: Files by Component

### Core Infrastructure:
- `cli-generate.ts` — main entry, orchestrates rendering
- `html-template.ts` — CSS + HTML skeleton
- `lib/chart-config.ts` — theme + Chart.js defaults
- `lib/validate.ts` — input validation
- `lib/formatters.ts` — display formatting

### Components (Phase 1-3):
- `components/header.ts` — metadata banner
- `components/kpi-cards.ts` — 4x summary stats
- `components/quality-gauge.ts` — MQ score radial
- `components/document-distribution.ts` — metadata charts
- `components/version-analysis.ts` — version pair viz
- `components/requirements-landscape.ts` — requirement breakdown
- `components/reference-graph.ts` — reference network
- `components/parse-health.ts` — parse success + OCR status
- `components/rag-decisions.ts` — consistency checks
- `components/footer.ts` — footer + export buttons

### Testing:
- `_fixtures/sample-reports.ts` — test data

---

## Known Limitations (Phase 0-1)

1. **No interactive features yet** — all charts static rendering
2. **No server mode** — only static HTML export
3. **No PDF export** — Phase 5 feature
4. **Chart.js embedded inline** — larger HTML but guaranteed offline
5. **D3 not initialized** — Phase 3 feature

## Testing: Phase 0-1 Smoke Test

```bash
# 1. Install dependencies
bun install

# 2. Generate test HTML (creates /tmp/test-dashboard.html)
bun run dashboard:generate <(echo '{ ... sample report JSON ... }') --output /tmp/test.html

# 3. Open in browser
# Linux:   xdg-open /tmp/test.html
# macOS:   open /tmp/test.html
# Windows: start /tmp/test.html

# 4. Verify:
#    - Header displays scan ID + timestamp
#    - 4 KPI cards show correct numbers
#    - No red console errors
#    - Responsive on mobile (Ctrl+Shift+M in DevTools)
```

---

## Progress Tracking

- **Phase 0**: DONE ✓ (2026-04-22)
- **Phase 1**: TODO (estimated 3-4 hours)
- **Phase 2**: TODO (estimated 4-5 hours)
- **Phase 3**: TODO (estimated 3-4 hours)
- **Phase 4**: TODO (estimated 2-3 hours)
- **Phase 5**: TODO (estimated 2-3 hours)
- **Phase 6**: TODO (estimated 2-3 hours)

**Total Estimated Time:** 18-24 hours of implementation
