"""Indexing orchestration — chunk → embed → upsert with cache awareness.

Mirrors the prior TS pipeline (`packages/cli/src/indexing/index-project.ts`)
but runs entirely inside the sidecar so:

  - the Bun parent doesn't have to round-trip per file/chunk/batch;
  - parallelism uses real OS threads (parallelize), not Promise.all;
  - the embedder + vector index are warm singletons for the daemon's life.

Progress events go back over stdout as `progress` frames so the parent
CLI can render the same status bar it does today, without owning any
of the heavy lifting.
"""

from std.python import PythonObject, Python
from std.os.path import join
from std.pathlib import Path
from std.time import perf_counter_ns

from chunker import CodeChunk, chunk_file
from embedder import Embedder
from vectors import VectorIndex, ChunkMeta
from store import ChunkStore, StoredChunk
from cache import read_cached, write_cached
from protocol import FRAME_PROGRESS, emit_frame, emit_phase


comptime EMBED_BATCH_SIZE = 256


@fieldwise_init
struct ApplyDiffStats(Copyable, Movable):
    var indexed_chunks: Int
    var failed_files: Int
    var deleted_files: Int


def apply_diff(
    request_id: String,
    project_root: String,
    cache_dir: String,
    changes: PythonObject,  # list of {path,type,hash?}
    mut embedder: Embedder,
    mut store: ChunkStore,
    mut index: VectorIndex,
) raises -> ApplyDiffStats:
    var py = Python.import_module("builtins")

    # Partition changes — deletions first (cheapest, frees rows).
    var delete_paths = List[String]()
    var index_paths = List[String]()
    var nc = Int(py=py.len(changes))
    for i in range(nc):
        var ch = changes[i]
        var t = String(py=ch["type"])
        var path_s = String(py=ch["path"])
        if t == "deleted":
            delete_paths.append(path_s)
        else:
            index_paths.append(path_s)

    # 1. Apply deletions to both stores (durable + in-memory).
    store.delete_by_files(delete_paths)
    for p in delete_paths:
        index.delete_by_file(p)

    # 2. Chunk every changed file. Serialized: `chunk_file` calls
    # tree-sitter via the Python C API, and Mojo's `parallelize` workers
    # don't hold the GIL — running this in parallel aborts the process
    # ("UniversalExceptionRaise" inside libpython). Per-file work is
    # cheap; the embedding step downstream is the real bottleneck.
    var n_index = index_paths.__len__()
    var per_file_chunks = List[List[CodeChunk]]()
    var failures = 0
    for _ in range(n_index):
        per_file_chunks.append(List[CodeChunk]())
    _emit_progress(request_id, "chunk", 0, n_index)
    var t_chunk = perf_counter_ns()
    for i in range(n_index):
        try:
            var rel = index_paths[i]
            var abs_path = join(project_root, rel)
            var text = Path(abs_path).read_text()
            per_file_chunks[i] = chunk_file(rel, text)
        except:
            failures += 1
        # Stream progress periodically so the parent CLI sees movement
        # on big repos without overwhelming the pipe.
        if (i + 1) % 32 == 0 or i + 1 == n_index:
            _emit_progress(request_id, "chunk", i + 1, n_index)
    emit_phase(request_id, String("chunk_total"),
               perf_counter_ns() - t_chunk,
               String(n_index) + String(" files, ")
                 + String(failures) + String(" failed"))

    # 3. Flatten + cache lookup. We only embed the cache misses; hits go
    #    straight into the upsert/index path with the cached vector.
    var t_cache = perf_counter_ns()
    var pending_chunks = List[CodeChunk]()  # cache misses
    var pending_texts = List[String]()
    var ready_chunks = List[CodeChunk]()    # cache hits
    var ready_vectors = List[List[Float32]]()
    var produced = 0
    for i in range(per_file_chunks.__len__()):
        var cs = per_file_chunks[i].copy()
        produced += cs.__len__()
        for c in cs:
            var cached = read_cached(cache_dir, c.chunk_hash, embedder.dim)
            if cached.__len__() == embedder.dim:
                ready_chunks.append(c.copy())
                ready_vectors.append(cached^)
            else:
                pending_chunks.append(c.copy())
                pending_texts.append(c.content)
    emit_phase(request_id, String("cache_lookup"),
               perf_counter_ns() - t_cache,
               String(ready_chunks.__len__()) + String(" hits / ")
                 + String(produced) + String(" total"))

    # Join the off-thread MAX warm before we start emitting progress
    # for the embed step. If `_open` submitted `warm_async`, this
    # blocks here for whatever's still left of the import + graph
    # compile. If chunking already overlapped most of it, this is a
    # no-op; on small repos it ends up dominating the indexing phase
    # because there's nothing else to overlap with.
    embedder.warm(request_id=request_id)

    _emit_progress(request_id, "embed", 0, pending_chunks.__len__())

    # 4. Embed the misses in fixed-size batches. The model is single-
    #    threaded internally, so we batch sequentially — the GPU/torch
    #    runtime parallelizes per-batch.
    var t_embed = perf_counter_ns()
    var pending_vectors = List[List[Float32]]()
    var i_batch = 0
    while i_batch < pending_chunks.__len__():
        var end = i_batch + EMBED_BATCH_SIZE
        if end > pending_chunks.__len__():
            end = pending_chunks.__len__()
        var batch_texts = List[String]()
        for j in range(i_batch, end):
            batch_texts.append(pending_texts[j])
        var batch_vecs = embedder.embed_batch(batch_texts)
        for k in range(batch_vecs.__len__()):
            pending_vectors.append(batch_vecs[k].copy())
        # Persist cache as we go so a crash mid-index still saves work.
        for j in range(i_batch, end):
            try:
                write_cached(
                    cache_dir,
                    pending_chunks[j].chunk_hash,
                    pending_vectors[j].copy(),
                )
            except:
                pass
        _emit_progress(request_id, "embed", end, pending_chunks.__len__())
        i_batch = end
    emit_phase(request_id, String("embed_total"),
               perf_counter_ns() - t_embed,
               String(pending_chunks.__len__()) + String(" embedded"))

    # 5. Upsert everything (cache hits + freshly-embedded) into both stores.
    var stored = List[StoredChunk]()
    for i in range(ready_chunks.__len__()):
        stored.append(StoredChunk(
            chunk_hash=ready_chunks[i].chunk_hash,
            file_path=ready_chunks[i].file_path,
            start_line=ready_chunks[i].start_line,
            end_line=ready_chunks[i].end_line,
            content=ready_chunks[i].content,
            language=ready_chunks[i].language,
            vector=ready_vectors[i].copy(),
        ))
    for i in range(pending_chunks.__len__()):
        stored.append(StoredChunk(
            chunk_hash=pending_chunks[i].chunk_hash,
            file_path=pending_chunks[i].file_path,
            start_line=pending_chunks[i].start_line,
            end_line=pending_chunks[i].end_line,
            content=pending_chunks[i].content,
            language=pending_chunks[i].language,
            vector=pending_vectors[i].copy(),
        ))

    var t_db_upsert = perf_counter_ns()
    store.upsert_many(stored)
    emit_phase(request_id, String("db_upsert"),
               perf_counter_ns() - t_db_upsert,
               String(stored.__len__()) + String(" rows"))

    var t_idx_upsert = perf_counter_ns()
    for s in stored:
        index.upsert(
            s.chunk_hash,
            ChunkMeta(
                chunk_hash=s.chunk_hash,
                file_path=s.file_path,
                content=s.content,
                start_line=s.start_line,
                end_line=s.end_line,
            ),
            s.vector.copy(),
        )
    emit_phase(request_id, String("index_upsert"),
               perf_counter_ns() - t_idx_upsert,
               String("in-mem matrix grow + norm"))

    return ApplyDiffStats(
        indexed_chunks=stored.__len__(),
        failed_files=failures,
        deleted_files=delete_paths.__len__(),
    )


def _emit_progress(request_id: String, stage: String, done: Int, total: Int) raises:
    var py = Python.import_module("builtins")
    var payload = py.dict()
    payload["stage"] = stage
    payload["done"] = done
    payload["total"] = total
    emit_frame(request_id, FRAME_PROGRESS, payload)
