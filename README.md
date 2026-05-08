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
│  • Unix-socket server   │           │  • parallel file hashing    │
│  • auto-spawn / idle    │           │  • Merkle tree + diff       │
│    shutdown             │           │  • Tree-sitter chunking     │
│  • daemon PID/log files │           │  • async MAX warm-up        │
│  • AI SDK routing       │           │  • SQLite + vector cache    │
│    (cloud mode)         │           │  • SIMD cosine kNN          │
└─────────────────────────┘           └─────────────────────────────┘
```

The Bun parent owns the CLI surface, the Unix-socket HTTP server (so
`vgrep search` from another shell still feels instant), and the AI SDK
provider plumbing for cloud mode. The Mojo sidecar owns every CPU- or
I/O-bound stage; it loads the embedding model exactly once at daemon
startup and keeps the entire vector corpus resident in a single
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
2. **Hash** — Builds a Merkle tree (parallelized across CPU threads via `std.algorithm.parallelize`) for instant diff detection.
3. **Chunk** — Splits files into semantic chunks at function/class boundaries via Tree-sitter.
4. **Embed** — Computes 384-dim vectors with MiniLM-L6-v2 through the in-process MAX engine; cache hits skip the model entirely.
5. **Store** — Upserts into SQLite (durable) and into the contiguous in-memory matrix (search-time hot path).
6. **Search** — Embeds the query and runs one fused `parallelize[vectorize[...]]` cosine pass over the matrix.

### The Daemon (auto-managed)

`vgrep search` auto-spawns a per-project background daemon if one isn't
already running, then keeps using it on subsequent searches.
It self-shuts-down after **15 minutes** of no `/search` traffic
(override with `VGREP_IDLE_TIMEOUT_MS=<ms>`; `0` disables).

You don't manage it. Same pattern as `rust-analyzer`, `gopls`,
`pyright`, and `ripgrep --server`: a tiny long-lived worker so the
expensive cold start (Python + MAX imports + graph compile) is paid
once, not on every keystroke.

`vgrep watch` is the explicit-control variant for users who want the
indexer always-on or want to see live polling output.

### Incremental Re-indexing

The Bun-side poller does a lightweight `size:mtime` scan every two
seconds, debounces bursts, and ships the candidate list to the
sidecar. The sidecar re-walks, hashes only changed files in parallel,
splices them into the previous Merkle tree, diffs, and re-embeds —
typically sub-second for a handful of file edits.

### Async warm-up

The Mojo sidecar imports MAX and compiles its inference graph on a
single-worker `ThreadPoolExecutor` while the main thread runs the
file walk and Merkle hash. On a fresh project, opening a session
returns in **~30 ms** (was ~5 s) because the heavy work overlaps
with I/O. The first embedding call joins the future before running.

---

## Commands

| Command | Description |
|---|---|
| `vgrep init` | Build the Merkle tree and index the codebase |
| `vgrep status` | Show index stats, root hash, simhash, and mode |
| `vgrep search "<query>"` | Search the local semantic index (auto-spawns the per-project daemon; auto-stops after 15 min idle) |
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

## Performance

vgrep ships with a per-step microbench that drives the Mojo sidecar
directly (no agent loop, no LLM, no network):

```bash
bun run packages/bench/src/core-bench.ts zustand --top-k 3
```

Sample output (Apple M-series CPU, MEF cache warm, no `.vgrep/cache`
hits):

```
phase                 duration   notes
──────────────────────────────────────────
clone                 798ms      depth=1, v5.0.0
spawn                 383ms      model loaded, stdio drained
open                  21ms       profiles=code, ignore=0B
  ├─ warm_submit      13ms       dispatch to vgrep-warm thread
  ├─ db_open          1ms        sqlite handle + empty in-mem index
  └─ index_load       7ms        0 cached chunks
tree                  10ms       44 files, 241.7KB
  ├─ walk             7ms        44 files
  ├─ merkle_build     3ms
  └─ tree_diff        102µs      44 changes
index                 8.13s      355 chunks, 0 failed
  ├─ chunk_total      61ms       44 files
  ├─ cache_lookup     1ms        0 hits / 355 total
  ├─ warm_join        4.20s      blocked time after async submit
  ├─ embed_total      2.99s      355 embedded
  ├─ db_upsert        63ms       355 rows
  └─ index_upsert     945µs      in-mem matrix grow + norm
search                6ms        mean of 4 runs (1 warmup discarded)
  ├─ query_embed      5ms        139 bytes
  ├─ knn              78µs       3 hits
  ├─ marshal          14µs
  ├─ p50              6ms
  ├─ p90              7ms
  └─ max              7ms
```

Every sub-row is emitted by the Mojo sidecar as an NDJSON
`{type: "phase", name, ns}` frame and collected by the bench harness.
The same instrumentation is available to any tool that wires an
`onPhase` observer onto a `SidecarClient` request — see
`packages/core/src/sidecar/client.ts`.

What it tells you on this run:
- **`open: 21 ms`** — the `vgrep init` / `searchViaDaemon` boot is
  near-instant because the MAX warm-up runs on a Python worker thread
  while walk/merkle/chunk run on the main thread.
- **`warm_join: 4.20 s`** — what was left of the MAX import + graph
  compile by the time the embedder was actually needed. On big repos
  the chunk phase fully absorbs this.
- **`embed_total: 2.99 s`** — the actual embedding work. Throughput
  matches the in-process MAX engine target (~1500 embeds/sec on
  M-series CPU).
- **`search: 6 ms`** — query embed dominates kNN by ~70×, so the
  matrix scan isn't the search-latency bottleneck.

## Design Notes

This section documents the constraints we hit while making the
sidecar fast and the decisions we landed on. It's the rationale
behind the auto-managed daemon and the in-process MAX path.

### Why a daemon at all

The first instinct for a CLI tool is "no background processes." We
investigated whether vgrep could meet that bar and found it can't,
for reasons that come from the upstream MAX/Mojo stack:

- The native Mojo `max.engine` / `max.graph` packages were
  **deprecated in v25.3 and removed in v25.4** (per the MAX
  changelog). Inference from Mojo today goes through Python's
  `max.pipelines.PIPELINE_REGISTRY.retrieve(...)`. Imports take
  3–8 seconds cold; they aren't optional.
- The HuggingFace tokenizer used by MiniLM is Python-only — there's
  no native Mojo BERT/WordPiece tokenizer in stdlib, `max.pipelines`,
  or first-party repos. Python on the hot path is unavoidable.
- MEF (the on-disk graph cache) handles the ~340 ms compile portion
  automatically; manual `export_compiled_model` save/load is, per
  Modular's own forum guidance, "largely obsolete" and not portable
  across machines or releases.
- There is no documented mmap / POSIX-shm / shared-model-state
  primitive in MAX. Modular's own answer for "load once, query many"
  is `max serve` — i.e. a daemon.

So the question isn't "daemon vs no daemon." It's "explicit daemon
vs invisible daemon." We chose invisible: `vgrep search` auto-spawns
the per-project worker if one isn't running, and the worker
self-shuts-down after 15 minutes of no `/search` traffic. If you
prefer always-on, `vgrep watch --start` keeps it up forever (or set
`VGREP_IDLE_TIMEOUT_MS=0`).

### Why the embedder runs in-process

The two viable shapes for "Bun CLI talks to MAX" are:

1. **In-process Mojo sidecar** with `max.pipelines.PIPELINE_REGISTRY`
   imported into the sidecar's Python interpreter. One process. One
   warm-up. Heavy, but only once.
2. **`max serve` worker** spawned by Mojo, talking HTTP. Modular's
   blessed pattern, but it adds another ~5 s of process-fork +
   re-import overhead on top of the graph compile.

We picked (1). Steady-state is ~14 ms/embedding at batch=1 and
~0.7 ms at batch=128 (~1500 embeds/sec on M-series CPU), beating
the `max serve` HTTP path by both throughput and latency.

### Why not Bun-FFI to a Mojo `.dylib`

`mojo build --emit shared-lib` + `@export(..., ABI="C")` + Bun's
`bun:ffi` is fully supported on every layer. We considered replacing
the spawn + NDJSON pipe with a direct dlopen.

The blocker: as long as the embedder calls `Python.import_module`,
the `.dylib` `dlopen`s libpython at first call and initializes a
CPython interpreter inside Bun's process. You eliminate the spawn
cost (real, milliseconds) but you inherit libpython discovery, GIL,
and MAX cold-start *inside Bun*. Net win for one-shot CLI is small
and shipping gets harder (you must ship a compatible CPython
alongside the bun-compiled binary).

So FFI is deferred until either MAX restores a native Mojo path
(see "Why a daemon at all") or the embedder is fully replaced with
something Python-free.

### What we did instrument

- Per-step `phase` frames over the existing NDJSON protocol so the
  bench shows `model_import` / `graph_compile` / `walk` /
  `merkle_build` / `chunk_total` / `cache_lookup` / `warm_join` /
  `embed_total` / `db_upsert` / `query_embed` / `knn` distinctly.
- `Embedder.warm_async()` submits the MAX import + graph compile to
  a single-worker Python `ThreadPoolExecutor` so the file walk and
  merkle hash run concurrently. `_open` returns in ~30 ms; the warm
  is joined just before the first embedding actually runs.
- Idle-shutdown for the auto-spawned daemon (`VGREP_IDLE_TIMEOUT_MS`,
  default 15 min). User never has to think about a process they
  didn't ask to start.

### Future work

- **EmberJson** to replace `Python.json` in `protocol.mojo`. Would
  remove one Python module from the boot path; small per-frame win.
- **Tree-sitter via DLHandle** to libtree-sitter. The chunker is the
  last GIL-bound stage on the main thread; native bindings would
  remove the ~80–120 ms of contention with the warm worker on big
  repos.
- **Split-binary distribution** — `vgrep-core` (Python-free hot path)
  + `vgrep-embed` (the only binary that links libpython). Lets us
  drop the pixi env from `~/.vgrep` and ship a relocatable bundle:
  `bin/`, `lib/` (MAX dylibs, RPATH=`@loader_path/../lib`), `python/`
  (python-build-standalone, ~30 MB), `models/` (~22 MB MiniLM).

---

## License

MIT

---
