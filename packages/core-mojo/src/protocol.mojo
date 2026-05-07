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

    `input()` raises EOFError when stdin closes; we surface that as
    `Error("EOF")` so `main` can treat it as a clean shutdown.
    """
    try:
        var line = input()
        if line.byte_length() == 0:
            raise Error("EOF")
        var json = Python.import_module("builtins").__import__("json")
        return json.loads(line)
    except:
        # `input()` raises on EOF (Mojo wraps as Error). Normalize so
        # the caller's match is simple.
        raise Error("EOF")
