"""Embedding inference via sentence-transformers.

The Python interop boundary is per-batch: we hand `model.encode(...)`
a list of strings, get back an `(N, dim)` numpy array, and copy it
once into Mojo `List[Float32]` rows. The matmul itself runs in
PyTorch / ONNX with the model's own threading.

We deliberately do *not* parallelize at this level — concurrent encode
calls just contend for the same GIL + tensor cores.

The model loads once at sidecar startup and lives for the daemon
lifetime. First call pays the warmup; everything after is hot.
"""

from std.python import PythonObject, Python


comptime DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
comptime DEFAULT_DIM = 384


struct Embedder(Movable):
    var model: PythonObject
    var dim: Int

    def __init__(out self, model_name: String = DEFAULT_MODEL) raises:
        var st = Python.import_module("sentence_transformers")
        self.model = st.SentenceTransformer(model_name)
        self.dim = Int(py=self.model.get_embedding_dimension())

    def embed_batch(self, texts: List[String]) raises -> List[List[Float32]]:
        """Encode N texts → N float32 vectors of length `self.dim`.

        Normalization stays in Mojo (`VectorIndex.upsert` divides by the
        precomputed L2 norm at search time) so we have one place that
        owns it and one bug surface.
        """
        var py = Python.import_module("builtins")
        var py_list = py.list()
        for t in texts:
            py_list.append(t)
        var arr = self.model.encode(py_list, convert_to_numpy=True)
        var n = Int(py=arr.shape[0])
        var d = Int(py=arr.shape[1])
        if d != self.dim:
            raise Error("embedder: unexpected dim from model")

        var out = List[List[Float32]]()
        for i in range(n):
            var row = List[Float32]()
            for j in range(d):
                row.append(Float32(Float64(py=arr[i, j])))
            out.append(row^)
        return out^

    def embed_one(self, text: String) raises -> List[Float32]:
        var batch = List[String]()
        batch.append(text)
        var batch_vecs = self.embed_batch(batch)
        return batch_vecs[0].copy()
