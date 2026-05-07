"""SHA-256 file hashing.

The hash itself goes through Python's `hashlib.sha256` — that
dispatches to OpenSSL / CommonCrypto with the SHA-NI / ARMv8 SHA
extensions, so we get hardware-accelerated SHA without writing the
intrinsics ourselves.

We deliberately do *not* run hashing through Mojo's `parallelize` —
every file read goes through the Python C API (`pathlib.Path.read_bytes`,
`hashlib.sha256`), and that requires the GIL. Calling those from
multiple Mojo worker threads concurrently triggers a fatal abort
("UniversalExceptionRaise: (os/kern) failure (5)") inside libpython.

Parallelism for the I/O-bound part lives Python-side via a
`ThreadPoolExecutor` — Python releases the GIL across `read_bytes`
and inside the OpenSSL/CommonCrypto SHA core, so we still get the
disk-bound speedup without violating GIL invariants.
"""

from std.python import PythonObject, Python


@fieldwise_init
struct FileHash(Copyable, Movable):
    var rel_path: String
    var hex: String
    var size: Int
    var mtime_ms: Int


def hash_one(project_root: String, rel: String) raises -> String:
    """Hex SHA-256 of one file's contents."""
    var hashlib = Python.import_module("hashlib")
    var pathlib = Python.import_module("pathlib")
    var os_mod = Python.import_module("os")
    var abs = os_mod.path.join(project_root, rel)
    var data = pathlib.Path(abs).read_bytes()
    var h = hashlib.sha256(data)
    return String(py=h.hexdigest())


def hash_many(
    project_root: String,
    paths: List[String],
    sizes: List[Int],
    mtimes: List[Int],
) raises -> List[FileHash]:
    """Hash a batch of files. Parallelism is delegated to a Python
    `ThreadPoolExecutor` so the GIL is honored — Mojo `parallelize`
    over Python calls aborts the process."""
    var n = paths.__len__()
    if n == 0:
        return List[FileHash]()

    var py = Python.import_module("builtins")
    var futures_mod = Python.import_module("concurrent.futures")
    var os_mod = Python.import_module("os")

    # Build absolute paths once on the Mojo side so the worker only
    # crosses the boundary for I/O + hashing.
    var py_paths = py.list()
    for i in range(n):
        py_paths.append(os_mod.path.join(project_root, paths[i]))

    # Worker is a tiny lambda that reads + hashes one path. Defining
    # it via `Python.evaluate` keeps it in pure Python so the executor
    # threads never touch the Mojo runtime concurrently.
    var worker = Python.evaluate(
        "__import__('functools').partial("
        "lambda p: __import__('hashlib').sha256("
        "__import__('pathlib').Path(p).read_bytes()).hexdigest()"
        ")"
    )
    var executor = futures_mod.ThreadPoolExecutor(max_workers=32)
    var results = py.list(executor.map(worker, py_paths))
    executor.shutdown(wait=True)

    var out = List[FileHash]()
    for i in range(n):
        var hex = String(py=results[i])
        if hex.byte_length() == 0:
            continue
        out.append(FileHash(
            rel_path=paths[i],
            hex=hex,
            size=sizes[i],
            mtime_ms=mtimes[i],
        ))
    return out^
