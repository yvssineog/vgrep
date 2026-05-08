"""NDJSON request/response framing shared with the Bun parent.

Single-threaded I/O at this boundary: the main loop reads one request
line, dispatches it, and the handler may emit any number of `progress`
frames before the final `result` or `error`. All frames share the
request `id` so the parent can multiplex.

JSON is the one place we still defer to Python — Mojo 1.0.0b1 has no
native JSON encoder, and rolling our own would buy nothing measurable
since these calls are ≤O(KB) per request.

stdin/stdout themselves are pure Mojo (`input()` + `print()`); we only
reach into Python when we need `json.loads`/`json.dumps`.
"""

from std.python import PythonObject, Python


# Method names — must match `packages/core/src/sidecar/protocol.ts`.
comptime METHOD_OPEN = "open"
comptime METHOD_CLOSE = "close"
comptime METHOD_HEALTH = "health"
comptime METHOD_BUILD_TREE = "merkle.build"
comptime METHOD_UPDATE_TREE = "merkle.update"
comptime METHOD_APPLY_DIFF = "index.applyDiff"
comptime METHOD_SEARCH = "search"


# Frame types.
comptime FRAME_RESULT = "result"
comptime FRAME_ERROR = "error"
comptime FRAME_PROGRESS = "progress"
comptime FRAME_PHASE = "phase"


def emit_phase(id: String, name: String, ns: UInt, notes: String = "") raises:
    """Emit a single completed-step timing frame.

    Distinct from `progress` (incremental done/total): a `phase` frame
    fires once per discrete step with its measured duration, so the
    bench harness can attach it as a child of the parent request and
    show where time actually went without us having to maintain a
    parallel timing channel from the parent process.
    """
    var py = Python.import_module("builtins")
    var payload = py.dict()
    payload["name"] = name
    payload["ns"] = Int(ns)
    if notes.byte_length() > 0:
        payload["notes"] = notes
    emit_frame(id, FRAME_PHASE, payload)


def emit_frame(id: String, kind: String, payload: PythonObject) raises:
    """Write one NDJSON frame to stdout.

    `payload` is a Python dict of extra keys to splat at the top level
    so the parent reads e.g. `{id, type:"result", result:{...}}` rather
    than a nested `payload` envelope.
    """
    var json = Python.import_module("builtins").__import__("json")
    var envelope = Python.dict()
    envelope["id"] = id
    envelope["type"] = kind
    for key in payload.keys():
        envelope[key] = payload[key]
    var line = json.dumps(envelope)
    # `print` already calls libc puts + flush; that's enough for line-
    # delimited NDJSON. The parent reads with a streaming line reader.
    print(String(py=line), flush=True)


def read_request() raises -> PythonObject:
    """Block on stdin for one NDJSON request line; returns a Python dict.

    We delegate the read to Python's `sys.stdin.readline()` rather than
    Mojo's `input()` because the latter has a buffering quirk in 1.0.0b1
    that returns empty on the second read when stdin is a non-tty pipe —
    which is exactly the situation when Bun spawns the sidecar with
    `stdin: "pipe"`. `sys.stdin` honors line buffering correctly.
    """
    var sys_mod = Python.import_module("sys")
    var raw = sys_mod.stdin.readline()
    var py = Python.import_module("builtins")
    if Int(py=py.len(raw)) == 0:
        raise Error("EOF")
    var line = String(py=py.str(raw).rstrip("\n"))
    if line.byte_length() == 0:
        # Empty line — skip and try again. (Don't treat as EOF; only
        # zero-byte readline means EOF.)
        return read_request()
    var json = Python.import_module("builtins").__import__("json")
    return json.loads(line)
