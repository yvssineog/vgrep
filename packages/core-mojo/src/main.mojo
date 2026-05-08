"""Sidecar entrypoint — reads NDJSON requests on stdin, dispatches.

State held by this process:
  - `Embedder` instance (model loaded once at first `open` request)
  - `ChunkStore` (SQLite handle) + `VectorIndex` (in-memory matrix)
  - `IgnoreRules` + `Profile` for the active project

The Bun parent talks to exactly one of these per project for the
daemon's lifetime, so first-request latency (model warmup) is the
only slow path; everything after is hot.

Errors raised by handlers are caught here and reported as
`{type:"error"}` frames, never killing the process — the parent
treats them like any HTTP 5xx and may retry.
"""

from std.python import PythonObject, Python
from std.sys import exit
from std.time import perf_counter_ns

from protocol import (
    FRAME_RESULT, FRAME_ERROR,
    METHOD_OPEN, METHOD_CLOSE, METHOD_HEALTH,
    METHOD_BUILD_TREE, METHOD_UPDATE_TREE,
    METHOD_APPLY_DIFF, METHOD_SEARCH,
    emit_frame, emit_phase, read_request,
)
from ignore import IgnoreRules, parse_ignore_text, empty_ignore
from walk import Profile, walk
from merkle import build_tree, diff_trees
from hash import hash_one
from chunker import chunk_file
from embedder import Embedder
from vectors import VectorIndex, ChunkMeta, SearchHit
from store import ChunkStore
from index import apply_diff


# Process-global session — Mojo doesn't have module-level mutable state
# the way Python does, so we hand a `Session` reference through every
# handler explicitly.
struct Session:
    var project_root: String
    var cache_dir: String
    var rules: IgnoreRules
    var profile: Profile
    var embedder: Embedder
    var store: ChunkStore
    var index: VectorIndex
    var opened: Bool

    def __init__(out self) raises:
        self.project_root = String("")
        self.cache_dir = String("")
        self.rules = empty_ignore()
        self.profile = Profile(extensions=List[String](), filenames=List[String]())
        # Construct lazily — `Embedder.__init__` is now a no-op; the heavy
        # MAX import + graph compile happens on first `embed_*` call (or
        # eagerly in `_open` if we want to overlap it with file walk).
        self.embedder = Embedder()
        self.store = ChunkStore(":memory:", self.embedder.dim)
        self.index = VectorIndex(dim=self.embedder.dim)
        self.opened = False


def main() raises:
    var session = Session()
    while True:
        try:
            var req = read_request()
            _dispatch(session, req)
        except e:
            # `read_request` raises on EOF — that's our clean shutdown.
            if String(e) == "EOF":
                break
            # Any other error inside dispatch is wrapped as a frame; if
            # we got here, the request frame itself was malformed.
            try:
                _emit_error(String(""), String(e))
            except:
                pass


def _dispatch(mut session: Session, req: PythonObject) raises:
    var py = Python.import_module("builtins")
    var request_id = String(py.str(req["id"]))
    var method = String(py.str(req["method"]))
    var params = req["params"]

    try:
        if method == METHOD_HEALTH:
            _emit_result(request_id, _ok())
            return
        if method == METHOD_OPEN:
            _open(session, request_id, params)
            return
        if method == METHOD_CLOSE:
            _emit_result(request_id, _ok())
            return
        if method == METHOD_BUILD_TREE:
            _build_tree(session, request_id)
            return
        if method == METHOD_UPDATE_TREE:
            _update_tree(session, request_id, params)
            return
        if method == METHOD_APPLY_DIFF:
            _apply_diff(session, request_id, params)
            return
        if method == METHOD_SEARCH:
            _search(session, request_id, params)
            return
        _emit_error(request_id, String("unknown method: ") + method)
    except e:
        _emit_error(request_id, String(e))


def _open(mut session: Session, request_id: String, params: PythonObject) raises:
    """Reload session state for a project and rebuild the in-memory index."""
    var py = Python.import_module("builtins")

    session.project_root = String(py.str(params["projectRoot"]))
    session.cache_dir = String(py.str(params["cacheDir"]))
    var db_path = String(py.str(params["dbPath"]))

    # Profile (extensions + filenames).
    var ext = List[String]()
    var fns = List[String]()
    var p_ext = params["extensions"]
    var p_fn = params["filenames"]
    var n_ext = Int(py=py.len(p_ext))
    var n_fn = Int(py=py.len(p_fn))
    for i in range(n_ext):
        ext.append(String(py.str(p_ext[i])))
    for i in range(n_fn):
        fns.append(String(py.str(p_fn[i])))
    session.profile = Profile(extensions=ext^, filenames=fns^)

    # Ignore rules — `.vgrepignore` parsed by the parent and shipped here
    # as raw text so we don't have to know the project layout twice.
    var ignore_text = String(py.str(params.get("ignoreText", "")))
    session.rules = parse_ignore_text(ignore_text)

    # Submit MAX warm-up to a background Python thread so the file
    # walk + merkle hash stages (which run on the main thread inside
    # `_update_tree` and don't touch the GIL) can overlap with the
    # 3–8s of `max.pipelines` imports + graph compile. The actual
    # `model_import`/`graph_compile` phase frames are still emitted
    # from inside `_build_pipeline` (it just runs on the worker).
    var t_submit = perf_counter_ns()
    session.embedder.warm_async()
    emit_phase(request_id, String("warm_submit"),
               perf_counter_ns() - t_submit,
               String("dispatch to vgrep-warm thread"))

    # Reopen the durable store and warm the in-memory index from it.
    var t_db = perf_counter_ns()
    session.store = ChunkStore(db_path, session.embedder.dim)
    session.index = VectorIndex(dim=session.embedder.dim, initial_capacity=4096)
    emit_phase(request_id, String("db_open"), perf_counter_ns() - t_db,
               String("sqlite handle + empty in-mem index"))

    var t_load = perf_counter_ns()
    var rows = session.store.load_all()
    var struct_mod = Python.import_module("struct")
    var fmt = String("<") + String(session.embedder.dim) + String("f")
    var loaded = 0
    while True:
        try:
            var row = py.next(rows)
            var blob = row[5]
            var floats = struct_mod.unpack(fmt, blob)
            var vec = List[Float32]()
            for j in range(session.embedder.dim):
                vec.append(Float32(Float64(py=floats[j])))
            session.index.upsert(
                String(py.str(row[0])),
                ChunkMeta(
                    chunk_hash=String(py.str(row[0])),
                    file_path=String(py.str(row[1])),
                    content=String(py.str(row[4])),
                    start_line=Int(py=row[2]),
                    end_line=Int(py=row[3]),
                ),
                vec,
            )
            loaded += 1
        except:
            break
    emit_phase(request_id, String("index_load"), perf_counter_ns() - t_load,
               String(loaded) + String(" cached chunks"))
    session.opened = True
    _emit_result(request_id, _ok())


def _build_tree(session: Session, request_id: String) raises:
    var files = walk(session.project_root, session.profile, session.rules)
    var tree = build_tree(session.project_root, files)
    var py = Python.import_module("builtins")
    var payload = py.dict()
    payload["result"] = py.dict()
    payload["result"]["tree"] = tree
    _emit_result_raw(request_id, payload)


def _update_tree(session: Session, request_id: String, params: PythonObject) raises:
    var py = Python.import_module("builtins")
    var prev = params.get("previous", py.None)

    var t_walk = perf_counter_ns()
    var files = walk(session.project_root, session.profile, session.rules)
    emit_phase(request_id, String("walk"), perf_counter_ns() - t_walk,
               String(files.__len__()) + String(" files"))

    var t_build = perf_counter_ns()
    var current = build_tree(session.project_root, files)
    emit_phase(request_id, String("merkle_build"),
               perf_counter_ns() - t_build, String(""))

    var t_diff = perf_counter_ns()
    var changes = diff_trees(prev, current)
    emit_phase(request_id, String("tree_diff"),
               perf_counter_ns() - t_diff,
               String(Int(py=py.len(changes))) + String(" changes"))

    var payload = py.dict()
    payload["result"] = py.dict()
    payload["result"]["tree"] = current
    payload["result"]["changes"] = changes
    _emit_result_raw(request_id, payload)


def _apply_diff(
    mut session: Session, request_id: String, params: PythonObject
) raises:
    var py = Python.import_module("builtins")
    var changes = params["changes"]
    var stats = apply_diff(
        request_id,
        session.project_root,
        session.cache_dir,
        changes,
        session.embedder,
        session.store,
        session.index,
    )
    var payload = py.dict()
    payload["result"] = py.dict()
    payload["result"]["indexedChunks"] = stats.indexed_chunks
    payload["result"]["failedFiles"] = stats.failed_files
    payload["result"]["deletedFiles"] = stats.deleted_files
    _emit_result_raw(request_id, payload)


def _search(mut session: Session, request_id: String, params: PythonObject) raises:
    var py = Python.import_module("builtins")
    var query = String(py.str(params["query"]))
    var top_k = Int(py=params.get("topK", 10))

    # Join any in-flight async warm so its cost is attributable on its
    # own, not lumped into `query_embed`.
    session.embedder.warm(request_id=request_id)

    var t_qe = perf_counter_ns()
    var qvec = session.embedder.embed_one(query)
    emit_phase(request_id, String("query_embed"), perf_counter_ns() - t_qe,
               String(query.byte_length()) + String(" bytes"))

    var t_knn = perf_counter_ns()
    var hits = session.index.search(qvec, top_k)
    emit_phase(request_id, String("knn"), perf_counter_ns() - t_knn,
               String(hits.__len__()) + String(" hits"))

    var t_marshal = perf_counter_ns()
    var arr = py.list()
    for h in hits:
        var item = py.dict()
        item["filePath"] = h.meta.file_path
        item["content"] = h.meta.content
        item["startLine"] = h.meta.start_line
        item["endLine"] = h.meta.end_line
        item["score"] = Float64(h.score)
        arr.append(item)
    emit_phase(request_id, String("marshal"),
               perf_counter_ns() - t_marshal, String(""))

    var payload = py.dict()
    payload["result"] = py.dict()
    payload["result"]["results"] = arr
    _emit_result_raw(request_id, payload)


# ─── tiny frame helpers ────────────────────────────────────────────────

def _ok() raises -> PythonObject:
    var py = Python.import_module("builtins")
    var payload = py.dict()
    payload["result"] = py.dict()
    payload["result"]["ok"] = True
    return payload


def _emit_result(request_id: String, payload: PythonObject) raises:
    emit_frame(request_id, FRAME_RESULT, payload)


def _emit_result_raw(request_id: String, payload: PythonObject) raises:
    emit_frame(request_id, FRAME_RESULT, payload)


def _emit_error(request_id: String, message: String) raises:
    var py = Python.import_module("builtins")
    var payload = py.dict()
    payload["error"] = message
    emit_frame(request_id, FRAME_ERROR, payload)
