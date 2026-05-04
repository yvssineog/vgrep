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
- **Blazing Fast** — Built on [Bun](https://bun.sh), compiled to a single standalone binary. Indexing uses SHA-256 Merkle trees for incremental updates, only re-indexes what changed.
- **Semantic Search** — Powered by `all-MiniLM-L6-v2` embeddings running locally via `@xenova/transformers`. No API keys needed.
- **Smart Diffing** — Merkle tree + simhash fingerprinting means re-indexing is near-instant for small changes.
- **Optional Cloud Sync** — Share indexes across your team via a serverless AWS backend (SST v3). Zero-ops deployment.

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

vgrep operates in two modes:

| | **Local Mode** (Default) | **Cloud Mode** |
|---|---|---|
| **Index storage** | `.vgrep/` directory in your project | AWS DynamoDB + Pinecone |
| **Embeddings** | LanceDB (local, zero-config) | Pinecone (managed, free tier) |
| **ML Model** | `@xenova/transformers` in Bun | Lambda-hosted |
| **Privacy** | 100% offline | Encrypted, team-scoped |
| **Sharing** | Single developer | Entire team |

### The Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌────────────────┐     ┌──────────────┐
│  File System │ ──→ │  Merkle Tree │ ──→ │  Code Chunker  │ ──→ │  Embeddings  │
│    Walker    │     │  (SHA-256)   │     │  (AST-aware)   │     │  (MiniLM)    │
└──────────────┘     └──────────────┘     └────────────────┘     └──────────────┘
                             │                                           │
                    ┌────────┴────────┐                         ┌────────┴────────┐
                    │  Diff Engine    │                         │  Vector Store   │
                    │  (incremental)  │                         │  (LanceDB)      │
                    └─────────────────┘                         └─────────────────┘
```

1. **Walk** — Recursively scans your project, respecting `.vgrepignore`.
2. **Hash** — Builds a Merkle tree (SHA-256) for instant diff detection.
3. **Chunk** — Splits files into semantic chunks (function/class boundaries).
4. **Embed** — Computes 384-dimensional vectors using MiniLM-L6-v2 (runs locally in Bun).
5. **Store** — Upserts vectors into LanceDB (local) or Pinecone (cloud).
6. **Search** — Converts your query to a vector and finds nearest neighbors.

### Incremental Re-indexing

In `watch` mode, filesystem events and lightweight metadata polling identify candidate paths first. The Merkle tree is then updated incrementally by re-hashing only those candidates and recalculating parent directory hashes.

On subsequent `init` runs, vgrep compares the previous Merkle snapshot with the current one and only re-indexes changed files.

---

## Commands

| Command | Description |
|---|---|
| `vgrep init` | Build the Merkle tree and index the codebase  |
| `vgrep status` | Show index stats, root hash, simhash, and mode  |
| `vgrep search "<query>"` | Search the local semantic index  |
| `vgrep watch` | Watch the repo in the foreground and keep the local index updated |
| `vgrep watch --start` | Start the watchdog in the background |
| `vgrep watch --logs` | Show the latest watchdog logs from `.vgrep/watch.log` |
| `vgrep watch --stop` | Stop the background watchdog |

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
