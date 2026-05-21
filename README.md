# huginn

Blind document intelligence — extract structure, metadata, and retrieval insights from document collections you can't read.

## Setup

```bash
git clone <repo-url>
cd huginn

# Place your documents in a directory, e.g.:
cp /path/to/your/documents/* _test-docs/

# Run (CPU-only — works on any host)
DOCUMENTS_PATH=./_test-docs docker compose up

# Or run with NVIDIA GPU (recommended for any model larger than 3B)
DOCUMENTS_PATH=./_test-docs docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

Open `http://localhost:3000` in a browser. On first boot, the setup wizard detects your hardware (GPU/VRAM via `nvidia-smi` when the GPU override is applied), recommends a chat model from a curated catalog of 13 options spanning CPU-viable through 140 GB VRAM, and downloads it on demand. You can swap models later from the Model Settings page.

Reports are written to `./reports/` as JSON, Markdown, and a narrative summary.

## How it works

huginn runs an 8-phase pipeline over your document folder:

1. **Harvest** — discovers files, computes checksums, infers project/customer from folder structure
2. **Parse** — extracts text from `.docx`, `.xlsx`, `.pptx` (officeparser) and `.pdf` (Apache Tika); detects language and headings
3. **Fingerprint** — builds a structural fingerprint and semantic embedding (Ollama) per document using headings only
4. **Cluster** — scores every document pair across 6 signals (filename similarity, structure, embeddings, directory, date) to find duplicate/version chains
5. **References** — extracts norm references (ISO/DIN/VDA/IATF), internal IDs, and chapter cross-references; resolves them across the corpus
6. **Requirements** — classifies sentences as MUSS/SOLL/KANN/DEKLARATIV requirements by section; spot-checks with LLM
7. **Validate** — runs consistency checks on parse success rate, requirement density, reference resolution, and version coverage
8. **Report** — writes three output files: structured JSON, human-readable Markdown, and an LLM-generated narrative summary

Everything runs locally. No document content leaves the machine.
