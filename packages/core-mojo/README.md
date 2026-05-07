# `@vgrep/core-mojo` — local processing sidecar

This package is the **Mojo half** of vgrep. The Bun CLI runs it as a
long-lived sidecar over `stdio` and delegates everything CPU/IO-heavy:

| Responsibility                | Owner          |
| ----------------------------- | -------------- |
| HTTP / Unix-socket server     | Bun (parent)   |
| AI SDK provider routing       | Bun (parent)   |
| CLI parsing, log/PID files    | Bun (parent)   |
| File walk + ignore rules      | **Mojo**       |
| SHA-256 + Merkle tree + diff  | **Mojo**       |
| Tree-sitter chunking          | **Mojo** (Python interop) |
| Embedding inference           | **Mojo** (Python interop) |
| SQLite + on-disk vector cache | **Mojo** (Python interop) |
| Cosine kNN over the corpus    | **Mojo** (SIMD + parallelize) |

The headline performance win lives in `src/vectors.mojo`: every chunk's
embedding is held in one contiguous `float32` buffer, and search is a
single fused `parallelize[vectorize[...]]` pass — no per-row BLOB decode,
no JS-side dot product loop.

## Build

```sh
# 1. install pixi (https://pixi.sh) — manages the Modular toolchain
# 2. inside this package:
pixi install            # resolves `mojo` from https://conda.modular.com/max/
pixi run build          # → dist/vgrep-core
```

The package depends on the **stable** Mojo channel (beta v1 line). To
track nightlies instead, swap the channel in `pixi.toml` for
`https://conda.modular.com/max-nightly/`.

Modular ships builds for `osx-arm64` (Apple Silicon), `linux-64`, and
`linux-aarch64` only — Intel Mac (`osx-64`) is unsupported upstream and
cannot be added to `platforms`.

That produces a single static binary at `dist/vgrep-core`. The Bun
release pipeline embeds it as a resource and extracts to `.vgrep/bin/`
on first run; nothing about the user-facing UX changes.

## Wire protocol

`stdin` and `stdout` are NDJSON. Each request looks like:

```json
{"id": "<uuid>", "method": "search", "params": {"query": "...", "topK": 10}}
```

The sidecar replies with one or more frames sharing the same `id`:

```json
{"id": "<uuid>", "type": "progress", "stage": "embed", "done": 12, "total": 256}
{"id": "<uuid>", "type": "result", "result": {...}}
```

Errors come back as `{"id": "...", "type": "error", "error": "<message>"}`.

See `src/protocol.mojo` for the full method list and
`packages/core/src/sidecar/protocol.ts` for the matching TypeScript types.

## Why Python interop for chunking + embedding

Tree-sitter and sentence-transformers are mature in Python. Re-implementing
them in pure Mojo would gate the rewrite on multi-week native binding work
for marginal speedup (these stages are I/O- and matmul-bound, both already
optimized in their native C/CUDA backends). The `Python.import_module`
bridge has near-zero per-call overhead once the interpreter is warm.

The pure-Mojo wins (kNN, hashing, walking) are where JavaScript was the
actual bottleneck.
