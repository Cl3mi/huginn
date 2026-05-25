# Muninn Mirror — Drift Tracking

These files are copied from `~/mci/muninn/packages/rag/src/ingestion/`.
When Muninn's chunker changes, sync manually and update the hashes below.

## Files and expected SHA-256

| File                  | SHA-256                                                            | Source                         |
|-----------------------|--------------------------------------------------------------------|--------------------------------|
| `chunker.ts`          | `190e5b52afa0e6874b7ab78803abfc5792d5febed64cb69b5ac69c889304941d` | muninn/...chunker.ts           |
| `cleaner.ts`          | `82baeb85a196bda641cfdc037b350d3089911fd736b694b0886c811526b534bb`  | muninn/...cleaner.ts           |
| `token-estimator.ts`  | (not tracked — dependency of cleaner.ts, no drift gate)            | muninn/...token-estimator.ts   |

## Sync procedure

1. Copy fresh files from Muninn:
   `cp ~/mci/muninn/packages/rag/src/ingestion/chunker.ts src/utils/muninn-mirror/chunker.ts`
   `cp ~/mci/muninn/packages/rag/src/ingestion/cleaner.ts src/utils/muninn-mirror/cleaner.ts`
   `cp ~/mci/muninn/packages/rag/src/ingestion/token-estimator.ts src/utils/muninn-mirror/token-estimator.ts`
2. Re-add the sync header comment at the top of each file.
3. Replace `@muninn/core` imports with local `./types.ts` / `./config.ts`.
   In `token-estimator.ts`: replace `import type { ChunkType } from "@muninn/core";` with `import type { ChunkType } from "./types.ts";`.
4. Recompute hashes: `sha256sum src/utils/muninn-mirror/chunker.ts src/utils/muninn-mirror/cleaner.ts`
5. Update the table above.
6. Run `bun run test:chunk-quality` — drift check should pass.
7. Commit with message: `chore(chunk-quality): sync muninn-mirror to muninn commit <hash>`
