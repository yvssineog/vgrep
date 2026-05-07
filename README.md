<p align="center">
  <h1 align="center">⚡ vgrep</h1>
  <p align="center"><strong>Vector Grep — Semantic search for your codebase</strong></p>
  <p align="center">
    <em>Local-first. Lightning fast. Privacy-respecting.</em>
  </p>
</p>


---

## What is vgrep?

**vgrep** is a semantic search engine for codebases, inspired by [Cursor's codebase indexing](https://cursor.com/en-US/blog/secure-codebase-indexing).

Traditional `grep` finds exact string matches. **vgrep** finds code that is *semantically related* to your query, even if it uses completely different variable names, function signatures, or phrasing.

```bash
# Traditional grep — only finds literal matches
grep -r "authenticate user" ./src    # ❌ misses "verify credentials", "login flow", "validate token"

# vgrep — finds semantically related code
vgrep search "authenticate user"     # ✅ finds all of the above
```

### Key Features

- **Local-First** — Runs 100% on your machine by default. Your code never leaves your computer.
- **Bun + Mojo** — A thin [Bun](https://bun.sh) CLI/server that delegates the heavy local-processing pipeline to a long-lived [Mojo](https://www.modular.com/mojo) sidecar. The Bun half handles HTTP, AI SDK provider routing, and orchestration; the Mojo half handles file walking, SHA-256 hashing, semantic chunking, embedding inference, and SIMD cosine kNN.
- **Semantic Search** — Default embedding model is `all-MiniLM-L6-v2`. The vector index is one contiguous float32 buffer; search is a fused `parallelize[vectorize[...]]` over every chunk in the corpus.
- **Smart Diffing** — Merkle tree of SHA-256 hashes lets re-indexing be O(changed files), not O(repo).
- **Optional Cloud Sync** — Share indexes across your team via a serverless AWS backend (SST v3). Zero-ops deployment.

## Building from source

vgrep ships as a single Bun-compiled binary that embeds the Mojo
sidecar. Building it locally requires both toolchains:

```bash
# Install pixi (manages the Modular/Mojo toolchain)
curl -fsSL https://pixi.sh/install.sh | bash

# Build the Mojo sidecar
cd packages/core-mojo
pixi install
pixi run build           # produces dist/vgrep-core

# Build the Bun front-end
cd ../cli
bun install
bun run build            # produces ./vgrep
```

For development you can skip the build step and run straight from
source — `bun packages/cli/src/cli.ts` will look for the sidecar
binary, fall back to `pixi run mojo run …` against the source tree,
and behave identically.

## Quick Start

```bash
# Navigate to any project
cd ~/projects/my-app

# Index the codebase (creates .vgrep/ directory)
vgrep init

# Check index status
vgrep status

# Search your code semantically
vgrep search "error handling for API responses"
```

### Example Output

```
⚡ vgrep init — /home/dev/my-app

  ├─ Scaffolded default .vgrepignore
  ├─ Files: 347
  ├─ Directories: 42
  ├─ Total size: 1.8 MB
  └─ Root hash: 9d84a3f1b2c4e7d8…

  Simhash: f3a5fae14e129930

✓ First index: 347 file(s) indexed.
  Index saved to .vgrep/merkle.json
```

---

## How It Works

### Architecture

vgrep is split across two processes that talk over `stdio`:

```
┌─────────────────────────┐  NDJSON   ┌─────────────────────────────┐
│  vgrep (Bun)            │◀─────────▶│  vgrep-core (Mojo sidecar)  │
│                         │           │                             │
│  • CLI parsing          │           │  • file walk + .vgrepignore │
│  • Unix-socket server   │           │  • SHA-256 + Merkle tree    │
│  • daemon PID/log files │           │  • Tree-sitter chunking     │
│  • AI SDK routing       │           │  • embedding inference      │
│    (cloud mode)         │           │  • SQLite + vector cache    │
│                         │           │  • SIMD cosine kNN          │
└─────────────────────────┘           └─────────────────────────────┘
```

The Bun parent owns the CLI surface, the Unix-socket HTTP server (so
`vgrep search` from another shell still feels instant), and the AI SDK
provider plumbing for cloud mode. The Mojo sidecar owns every CPU- or
I/O-bound stage; it loads the embedding model exactly once at daemon
startup and keeps the entire vector corpus mmap-resident in a single
contiguous `float32` buffer.

### The Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
│  File System │ ──→ │  Merkle Tree │ ──→ │  Code Chunker  │ ──→ │  Embeddings  │
│    Walker    │     │  (SHA-256)   │     │  (Tree-sitter) │     │  (MiniLM)    │
└──────────────┘     └──────────────┘     └────────────────┘     └──────────────┘
                                                                         │
                                                ┌────────────────────────┴────┐
                                                │  SQLite + flat float32 mmap │
                                                │  • durable rows in SQLite   │
                                                │  • one matrix in memory     │
                                                │  • SIMD parallelize[kNN]    │
                                                └─────────────────────────────┘
```

1. **Walk** — Recursively scans your project, respecting `.vgrepignore`.
2. **Hash** — Builds a Merkle tree (SHA-256, parallelized across CPU threads) for instant diff detection.
3. **Chunk** — Splits files into semantic chunks at function/class boundaries via Tree-sitter (8 files in parallel).
4. **Embed** — Computes 384-dim vectors with MiniLM-L6-v2; cache hits skip the model entirely.
5. **Store** — Upserts into SQLite (durable) and into the contiguous in-memory matrix (search-time hot path).
6. **Search** — Embeds the query and runs one fused `parallelize[vectorize[...]]` cosine pass over the matrix.

### Incremental Re-indexing

The Bun-side poller does a lightweight `size:mtime` scan every two
seconds, debounces bursts, and ships the candidate list to the
sidecar. The sidecar re-walks, hashes only changed files, splices them
into the previous Merkle tree, diffs, and re-embeds — typically
sub-second for a handful of file edits.

---

## Commands

| Command | Description |
|---|---|
| `vgrep init` | Build the Merkle tree and index the codebase  |
| `vgrep status` | Show index stats, root hash, simhash, and mode  |
| `vgrep search "<query>"` | Search the local semantic index  |
| `vgrep watch` | Run the daemon in the foreground: keep the index updated and serve searches |
| `vgrep watch --start` | Start the daemon in the background |
| `vgrep watch --logs` | Show the latest daemon logs from `.vgrep/daemon.log` |
| `vgrep watch --stop` | Stop the background daemon |

### Options

```bash
vgrep init --path ./my-project   # Scaffold .vgrepignore/config on first run
vgrep init --force               # Index after reviewing .vgrepignore/config
vgrep init --include docs,data   # Add docs/data to the default code profile
vgrep init --only code,styles    # Index only selected profiles
vgrep search "auth flow" --top-k 5
vgrep watch                      # Keep terminal open and log updates there
vgrep watch --start              # Run watchdog in the background
vgrep watch --logs               # Print the latest background logs
vgrep watch --stop               # Stop the background watchdog
vgrep --version                  # Show version
vgrep --help                     # Show help
```

---

## .vgrepignore

vgrep automatically creates a `.vgrepignore` file on `vgrep init`. It uses the same syntax as `.gitignore`:

```gitignore
# Ignore log files
*.log

# Ignore specific directories
vendor/
__pycache__/

# Ignore test fixtures
**/*.fixture.ts
__snapshots__/

# Ignore environment files
.env
.env.local
```

Built-in defaults (always ignored): `node_modules/`, `.git/`, `.vgrep/`, `dist/`, `build/`, `.next/`, `coverage/`.

---

## File Profiles

`vgrep init` also creates `.vgrep/config.json`, which declares index profiles:

- `code`: source files and code-adjacent files like `.java`, `.ts`, `.py`, `.sql`, `.proto`, `Dockerfile`, `Makefile`
- `docs`: `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `README`, `LICENSE`, `CHANGELOG`
- `data`: `.json`, `.yaml`, `.toml`, `.xml`, `.csv`, `.properties`, `.env`
- `styles`: `.css`, `.scss`, `.sass`, `.less`

The default is `code`. Use `--include` to add profiles to the default, or `--only` to replace it. You can create custom profiles by adding another entry under `fileProfiles` in `.vgrep/config.json`.

---

## Cloud Mode

> **Coming Soon** — Cloud Mode is not yet implemented.

Cloud Mode enables team-wide index sharing via a serverless AWS backend built with [SST v3](https://sst.dev).


---

## License

MIT

---
