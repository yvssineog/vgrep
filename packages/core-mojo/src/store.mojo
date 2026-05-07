"""SQLite-backed durable storage for chunks and embeddings.

Schema is identical to the previous TS engine so existing
`.vgrep/index.db` files load without migration:

  CREATE TABLE chunks (
    chunkhash TEXT PRIMARY KEY,
    filepath  TEXT NOT NULL,
    startline INTEGER NOT NULL,
    endline   INTEGER NOT NULL,
    content   TEXT NOT NULL,
    language  TEXT NOT NULL,
    vector    BLOB NOT NULL  -- Float32Array, little-endian
  );

The Mojo sidecar is the *only* writer to this DB — Bun never opens
it directly anymore, so we don't need cross-process locking beyond
SQLite's own WAL.

We use Python's stdlib `sqlite3` because:
  - it's bundled with the interpreter we already require for tree-sitter
    + sentence-transformers, so it's a zero-cost dep;
  - re-implementing the SQLite C bindings in Mojo via `external_call`
    is fine but buys nothing measurable here — bulk insert / select is
    bounded by SQLite, not by the FFI hop.
"""

from std.python import PythonObject, Python


@fieldwise_init
struct StoredChunk(Copyable, Movable):
    var chunk_hash: String
    var file_path: String
    var start_line: Int
    var end_line: Int
    var content: String
    var language: String
    var vector: List[Float32]


struct ChunkStore(Movable):
    var db: PythonObject
    var dim: Int

    def __init__(out self, db_path: String, dim: Int) raises:
        var sqlite3 = Python.import_module("sqlite3")
        var os = Python.import_module("os")
        var posixpath = Python.import_module("posixpath")
        # `posixpath.dirname(":memory:")` is "" — guard so we don't call
        # `os.makedirs("")` and so the in-memory startup path works.
        var parent = String(py=posixpath.dirname(db_path))
        if parent.byte_length() > 0:
            os.makedirs(parent, exist_ok=True)
        self.db = sqlite3.connect(db_path)
        self.dim = dim
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS chunks ("
            " chunkhash TEXT PRIMARY KEY,"
            " filepath  TEXT NOT NULL,"
            " startline INTEGER NOT NULL,"
            " endline   INTEGER NOT NULL,"
            " content   TEXT NOT NULL,"
            " language  TEXT NOT NULL,"
            " vector    BLOB NOT NULL )"
        )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_chunks_filepath ON chunks(filepath)"
        )
        self.db.commit()

    def __del__(deinit self):
        try:
            self.db.close()
        except:
            pass

    def has_index(self) raises -> Bool:
        var row = self.db.execute("SELECT COUNT(*) FROM chunks").fetchone()
        return Int(row[0]) > 0

    def upsert_many(mut self, chunks: List[StoredChunk]) raises:
        if chunks.__len__() == 0:
            return
        var py = Python.import_module("builtins")
        var np = Python.import_module("numpy")
        var rows = py.list()
        for c in chunks:
            # Build a Python list of floats, hand it to numpy as a
            # float32 array, then take its raw little-endian bytes —
            # avoids `struct.pack(*args)` which requires arg unpacking
            # (not supported in Mojo Python FFI).
            var vec_args = py.list()
            for v in c.vector:
                vec_args.append(Float64(v))
            var arr = np.asarray(vec_args, dtype="float32")
            var blob = arr.tobytes()
            var row_items = py.list()
            row_items.append(c.chunk_hash)
            row_items.append(c.file_path)
            row_items.append(c.start_line)
            row_items.append(c.end_line)
            row_items.append(c.content)
            row_items.append(c.language)
            row_items.append(blob)
            rows.append(py.tuple(row_items))
        self.db.executemany(
            "INSERT INTO chunks (chunkhash, filepath, startline, endline,"
            " content, language, vector) VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(chunkhash) DO UPDATE SET"
            " filepath  = excluded.filepath,"
            " startline = excluded.startline,"
            " endline   = excluded.endline,"
            " content   = excluded.content,"
            " language  = excluded.language,"
            " vector    = excluded.vector",
            rows,
        )
        self.db.commit()

    def delete_by_files(mut self, file_paths: List[String]) raises:
        if file_paths.__len__() == 0:
            return
        var py = Python.import_module("builtins")
        var rows = py.list()
        for p in file_paths:
            var one = py.list()
            one.append(p)
            rows.append(py.tuple(one))
        self.db.executemany("DELETE FROM chunks WHERE filepath = ?", rows)
        self.db.commit()

    def load_all(self) raises -> PythonObject:
        """Return an iterable of (hash, filepath, startline, endline, content, blob).

        Used at sidecar startup to rebuild the in-memory `VectorIndex` from
        the durable store.
        """
        return self.db.execute(
            "SELECT chunkhash, filepath, startline, endline, content, vector"
            " FROM chunks"
        )
