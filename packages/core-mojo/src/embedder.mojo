"""Embedding inference via the native MAX engine.

We call `max.pipelines.PIPELINE_REGISTRY.retrieve(...)` directly from
the Mojo sidecar — no HTTP, no `max serve` ASGI worker fork, no torch
or sentence-transformers in the dependency graph. The compiled MAX
graph stays loaded in this single Python interpreter for the life of
the daemon.

Why this path:
  - `max serve` boots an HTTP server in a *forked worker process*,
    which re-imports the entire MAX stack and adds ~5s of pure
    overhead on top of the graph compile.
  - In-process the cold-start is just one Python import chain (~3–8s
    depending on warm caches) + ~340ms of graph compile + first-batch
    warmup. Every subsequent encode is ~14ms warm at batch=1, ~85ms
    at batch=128 (~1500 embeds/sec on M-series CPU).

Cold-start floor on Apple Silicon (CPU device, MAX 26.3):
  - imports         ~3000–8000 ms (one-time, paid at sidecar boot)
  - PipelineConfig  ~150 ms
  - retrieve+compile ~340 ms
  - first embed     ~140 ms (graph warmup)
  - steady-state    ~14 ms / item @ batch=1, ~0.7 ms / item @ batch=128

Device note: MAX 26.3 has a graph-compile bug on Apple Silicon Metal
for both BertModel and MPNetForMaskedLM. We pin `--devices=cpu` until
upstream fixes it; throughput on M-series CPU is already excellent
for MiniLM-L6-v2.
"""

from std.python import PythonObject, Python
from std.time import perf_counter_ns

from protocol import emit_phase


comptime DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
comptime DEFAULT_DIM = 384
comptime DEFAULT_MAX_LENGTH = 256
comptime DEFAULT_MAX_BATCH = 128


# Python helper executed once at startup into a fresh namespace dict.
# Lives on a single-worker thread so we can submit the heavy MAX import
# + graph compile alongside the (pure-Mojo) file walk and merkle build,
# then `.result()` it before the first embed actually runs.
#
# We can't pass a Mojo struct method to a Python ThreadPoolExecutor
# directly — `submit` needs a real Python callable — so all the warm
# work stays Python-side and the result is read back into Mojo fields
# via dict-keyed access.
comptime WARM_HELPER_SRC = """
from concurrent.futures import ThreadPoolExecutor

def _build(model_name, max_length, max_batch):
    import asyncio
    from max.pipelines import PIPELINE_REGISTRY, PipelineConfig
    from max.driver import DeviceSpec
    from max.interfaces import (
        PipelineTask,
        EmbeddingsGenerationInputs,
        TextGenerationRequest,
        RequestID,
    )
    cfg = PipelineConfig(
        model_path=model_name,
        device_specs=[DeviceSpec.cpu()],
        max_length=max_length,
        max_batch_size=max_batch,
        enable_prefix_caching=False,
    )
    tokenizer, pipeline = PIPELINE_REGISTRY.retrieve(
        cfg, task=PipelineTask.EMBEDDINGS_GENERATION
    )
    return {
        'tokenizer': tokenizer,
        'pipeline': pipeline,
        'asyncio': asyncio,
        'max_length_py': tokenizer.max_length,
        'max_seq_len': int(tokenizer.max_length),
        'sep_token_id': int(tokenizer.eos),
        'inputs_cls': EmbeddingsGenerationInputs,
        'request_cls': TextGenerationRequest,
        'request_id_cls': RequestID,
    }


_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='vgrep-warm')


def submit(model_name, max_length, max_batch):
    return _executor.submit(_build, model_name, max_length, max_batch)
"""


struct Embedder(Movable):
    var pipeline: PythonObject
    var tokenizer: PythonObject
    var max_length_py: PythonObject
    var asyncio: PythonObject
    var inputs_cls: PythonObject
    var request_cls: PythonObject
    var request_id_cls: PythonObject
    var helper_ns: PythonObject
    var warm_future: PythonObject
    var max_seq_len: Int
    var sep_token_id: Int
    var dim: Int
    var ready: Bool
    var warm_submitted: Bool
    var model_name: String

    def __init__(out self, model_name: String = DEFAULT_MODEL) raises:
        # Defer the heavy work — `__init__` returns immediately with
        # `ready=False`. The first call to `embed_*` triggers compilation
        # so the daemon can answer a `health`/`open` ping while MAX is
        # still warming up in another thread (see `Embedder.warm_async`).
        var py = Python.import_module("builtins")
        self.pipeline = py.None
        self.tokenizer = py.None
        self.max_length_py = py.None
        self.asyncio = py.None
        self.inputs_cls = py.None
        self.request_cls = py.None
        self.request_id_cls = py.None
        self.helper_ns = py.None
        self.warm_future = py.None
        self.max_seq_len = DEFAULT_MAX_LENGTH
        self.sep_token_id = 102
        self.dim = DEFAULT_DIM
        self.ready = False
        self.warm_submitted = False
        self.model_name = model_name

    def warm(mut self, request_id: String = "") raises:
        """Eagerly load + compile, blocking. Idempotent.

        If `warm_async` already submitted the build off-thread, this
        joins the future instead of redoing the work. Otherwise it falls
        through to a synchronous build. When `request_id` is non-empty,
        the slow sub-steps emit `phase` frames so the bench can attribute
        cold-start cost.
        """
        if self.ready:
            return
        if self.warm_submitted:
            self._join_warm(request_id)
            return
        self._build_pipeline(request_id)

    def warm_async(mut self) raises:
        """Submit the MAX warm-up to a background Python thread.

        Returns immediately after handing the build to a single-worker
        `ThreadPoolExecutor`. The caller goes on to do pure-Mojo work
        (file walk, merkle hash) that doesn't touch the GIL, then calls
        `warm()` which joins the future. On `_open` for a fresh project
        this overlaps the ~6s MAX cold start with the ~10ms–10s walk —
        the bigger the repo, the bigger the saving.
        """
        if self.ready or self.warm_submitted:
            return
        self._ensure_helper()
        self.warm_future = self.helper_ns["submit"](
            self.model_name,
            DEFAULT_MAX_LENGTH,
            DEFAULT_MAX_BATCH,
        )
        self.warm_submitted = True

    def _ensure_helper(mut self) raises:
        """Compile the inline Python helper exactly once per process.

        The helper module owns the `ThreadPoolExecutor` so we don't leak
        a thread per `__init__`/`warm_async` cycle.
        """
        var py = Python.import_module("builtins")
        # PythonObject has no built-in `is None`; the bool of the
        # bound `dict` is True iff non-empty, so we track a Bool flag
        # implicitly via `helper_ns`'s identity vs `py.None`.
        if Bool(py.callable(self.helper_ns)) or Bool(py.isinstance(self.helper_ns, py.dict)):
            return
        var ns = py.dict()
        py.exec(WARM_HELPER_SRC, ns)
        self.helper_ns = ns

    def _join_warm(mut self, request_id: String = "") raises:
        """Block until the off-thread warm completes, copy results in."""
        var t_join = perf_counter_ns()
        var result = self.warm_future.result()
        self.tokenizer = result["tokenizer"]
        self.pipeline = result["pipeline"]
        self.asyncio = result["asyncio"]
        self.max_length_py = result["max_length_py"]
        self.max_seq_len = Int(py=result["max_seq_len"])
        self.sep_token_id = Int(py=result["sep_token_id"])
        self.inputs_cls = result["inputs_cls"]
        self.request_cls = result["request_cls"]
        self.request_id_cls = result["request_id_cls"]
        self.dim = DEFAULT_DIM
        self.ready = True
        self.warm_submitted = False
        var py = Python.import_module("builtins")
        self.warm_future = py.None
        if request_id.byte_length() > 0:
            emit_phase(request_id, String("warm_join"),
                       perf_counter_ns() - t_join,
                       String("blocked time after async submit"))

    def _build_pipeline(mut self, request_id: String = "") raises:
        var t_imports = perf_counter_ns()
        var py = Python.import_module("builtins")
        var pipelines = Python.import_module("max.pipelines")
        var driver = Python.import_module("max.driver")
        var interfaces = Python.import_module("max.interfaces")
        self.asyncio = Python.import_module("asyncio")
        if request_id.byte_length() > 0:
            emit_phase(request_id, String("model_import"),
                       perf_counter_ns() - t_imports,
                       String("max.pipelines + max.driver + asyncio"))

        var device_specs = py.list()
        device_specs.append(driver.DeviceSpec.cpu())

        # `PipelineConfig` runs through a kwarg-flattener that routes
        # `model_path`/`device_specs`/`max_length` into the nested
        # `MAXModelConfig`, and `enable_prefix_caching` etc. into the
        # KVCache config (BertModel auto-disables KV anyway).
        var t_compile = perf_counter_ns()
        var cfg = pipelines.PipelineConfig(
            model_path=self.model_name,
            device_specs=device_specs,
            max_length=DEFAULT_MAX_LENGTH,
            max_batch_size=DEFAULT_MAX_BATCH,
            # BertModel doesn't use a KV cache; the default
            # `enable_prefix_caching=True` triggers an "overriding" warning
            # at retrieve time. Set it explicitly to keep stderr clean.
            enable_prefix_caching=False,
        )

        var pair = pipelines.PIPELINE_REGISTRY.retrieve(
            cfg, task=interfaces.PipelineTask.EMBEDDINGS_GENERATION
        )
        if request_id.byte_length() > 0:
            emit_phase(request_id, String("graph_compile"),
                       perf_counter_ns() - t_compile,
                       String("PIPELINE_REGISTRY.retrieve (MEF cache)"))
        self.tokenizer = pair[0]
        self.pipeline = pair[1]
        # `TextTokenizer.encode` raises when a string encodes past
        # `tokenizer.max_length` — there's no truncation flag. We cache the
        # original cap (both as Mojo `Int` and as the Python object MAX
        # uses internally) so we can toggle it to `None` around the encode
        # call and restore it before `new_context` runs (which needs an
        # `int` for `max_tokens_to_generate` and `TextContext.max_length`).
        self.max_length_py = pair[0].max_length
        self.max_seq_len = Int(py=self.max_length_py)
        self.sep_token_id = Int(py=pair[0].eos)
        self.inputs_cls = interfaces.EmbeddingsGenerationInputs
        self.request_cls = interfaces.TextGenerationRequest
        self.request_id_cls = interfaces.RequestID

        # MiniLM-L6-v2 is 384-dim by spec. We could probe the model config
        # to be defensive (`pipeline.huggingface_config.hidden_size`) but
        # the compiled graph already enforces it.
        self.dim = DEFAULT_DIM
        self.ready = True

    def embed_batch(mut self, texts: List[String]) raises -> List[List[Float32]]:
        """Encode N texts → N float32 vectors of length `self.dim`.

        Vectors are returned unnormalized — `VectorIndex.upsert` divides
        by the precomputed L2 norm at search time, so we have one place
        that owns it.
        """
        if not self.ready:
            self.warm()

        var py = Python.import_module("builtins")
        var n = texts.__len__()
        if n == 0:
            return List[List[Float32]]()

        # 1. Build all the contexts. `tokenizer.new_context(...)` returns
        #    a coroutine — we run each through one persistent event loop
        #    via `loop.run_until_complete`. (One loop, N calls → no per-
        #    call asyncio.run setup/teardown overhead.)
        var loop = self.asyncio.new_event_loop()
        var cap = self.max_seq_len

        # Phase 1: encode every prompt through MAX's tokenizer with the
        # str-input length check disabled. HF stays an internal detail of
        # the MAX runtime — we never import it ourselves.
        self.tokenizer.max_length = py.None
        var token_lists = py.list()
        for i in range(n):
            var ids_np = loop.run_until_complete(
                self.tokenizer.encode(texts[i], add_special_tokens=True)
            )
            # `_generate_prompt_and_token_ids` dispatches on
            # `isinstance(prompt, list)`, so we have to hand it a real
            # Python list (not a numpy array).
            var token_ids = py.list(ids_np)
            if Int(py=py.len(token_ids)) > cap:
                # Keep [CLS] at position 0 and end on [SEP] to leave the
                # BERT input well-formed after truncation.
                token_ids = token_ids[py.slice(0, cap - 1)]
                token_ids.append(self.sep_token_id)
            token_lists.append(token_ids)
        # Restore the cap before `new_context` — `max_tokens_to_generate`
        # and `TextContext.max_length` both blow up on `None`.
        self.tokenizer.max_length = self.max_length_py

        # Phase 2: turn the prepared token lists into pipeline contexts.
        var ctxs = py.list()
        for i in range(n):
            var req = self.request_cls(
                request_id=self.request_id_cls(),
                prompt=token_lists[i],
                model_name=String("vgrep"),
            )
            var coro = self.tokenizer.new_context(req)
            ctxs.append(loop.run_until_complete(coro))
        loop.close()

        # 2. Build the inputs payload — one dict mapping request_id → ctx.
        var ctx_map = py.dict()
        for i in range(n):
            ctx_map[ctxs[i].request_id] = ctxs[i]
        var batches = py.list()
        batches.append(ctx_map)
        var inputs = self.inputs_cls(batches)

        # 3. Execute. `pipeline.execute` is sync from the caller's POV —
        #    MAX's scheduler internally batches across whatever tokens the
        #    graph can handle in one shot.
        var outputs = self.pipeline.execute(inputs)

        # 4. Walk the outputs in input order. `EmbeddingsGenerationOutput`
        #    exposes `.embeddings` as a numpy float32 array of length `dim`.
        var np = Python.import_module("numpy")
        var dim = self.dim
        var out_rows = List[List[Float32]]()
        for i in range(n):
            var rid = ctxs[i].request_id
            var ar = outputs[rid].embeddings
            # `tobytes()` is a single C-level memcpy → bytes; we then iterate
            # the bytes 4 at a time to reconstruct float32. This is the
            # cheapest path Mojo↔Python has today (one allocation, no
            # per-element FFI hops). For 256×384 floats the loop is ~1ms.
            var arr32 = np.ascontiguousarray(ar, dtype="float32")
            var buf = py.bytes(arr32.tobytes())
            var struct_mod = Python.import_module("struct")
            var fmt = String("<") + String(dim) + String("f")
            var floats = struct_mod.unpack(fmt, buf)
            var row = List[Float32]()
            for j in range(dim):
                row.append(Float32(Float64(py=floats[j])))
            out_rows.append(row^)
        return out_rows^

    def embed_one(mut self, text: String) raises -> List[Float32]:
        var batch = List[String]()
        batch.append(text)
        var batch_vecs = self.embed_batch(batch)
        return batch_vecs[0].copy()
