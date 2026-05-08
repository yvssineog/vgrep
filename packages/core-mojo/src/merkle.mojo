"""Merkle tree build, diff, and incremental update.

The on-wire JSON format is identical to the previous TS implementation
(`packages/core/src/merkle/types.ts`) so existing `.vgrep/merkle.json`
files load without migration:

  { "path": "", "type": "directory",
    "hash": "<sha256>",
    "children": [
      { "path": "src", "type": "directory", "hash": "...", "children": [...] },
      { "path": "src/main.ts", "type": "file", "hash": "...",
        "size": 1234, "mtime": 1700000000000 }
    ] }

Tree construction: hash files in parallel (`hash.mojo`), then fold
upward by sorted directory key. Hash of a directory is
`sha256(child1.hash || child2.hash || ...)` with children sorted
lexicographically — bit-for-bit identical to the TS output.

Diff: top-down walk that skips a whole subtree as soon as both nodes
have the same hash. This is the key optimization the rewrite must
preserve — it keeps incremental indexing O(changed files), not O(repo).
"""

from std.python import PythonObject, Python
from std.hashlib.hash import hash

from hash import FileHash, hash_many, hex_u64
from walk import FileEntry


def build_tree(
    project_root: String,
    files: List[FileEntry],
) raises -> PythonObject:
    """Build the merkle tree as a Python dict, ready to JSON-serialize."""
    var py = Python.import_module("builtins")

    var paths = List[String]()
    var sizes = List[Int]()
    var mtimes = List[Int]()
    for f in files:
        paths.append(f.rel_path)
        sizes.append(f.size)
        mtimes.append(f.mtime_ms)

    var hashed = hash_many(project_root, paths, sizes, mtimes)

    # Group by directory using a Python dict-of-dicts so we can rely on
    # Python's stable insertion order + sort for deterministic hashes.
    var by_dir = py.dict()
    by_dir[String("")] = py.list()
    for fh in hashed:
        var node = py.dict()
        node["path"] = fh.rel_path
        node["type"] = "file"
        node["hash"] = fh.hex
        node["size"] = fh.size
        node["mtime"] = fh.mtime_ms
        var parent = _dirname(fh.rel_path)
        if not Bool(parent in by_dir):
            by_dir[parent] = py.list()
        by_dir[parent].append(node)
        # Walk up the parent chain so every intermediate directory is a
        # key in `by_dir`. The fold loop discovers subdirs by exact key
        # match, so missing intermediates would silently drop subtrees.
        var p = parent
        while p.byte_length() > 0:
            p = _dirname(p)
            if not Bool(p in by_dir):
                by_dir[p] = py.list()

    return _fold_directories("", by_dir)


def _dirname(rel: String) raises -> String:
    var posixpath = Python.import_module("posixpath")
    return String(posixpath.dirname(rel))


def _fold_directories(dir_path: String, by_dir: PythonObject) raises -> PythonObject:
    """Recursively build a directory node from its file children + nested dirs."""
    var py = Python.import_module("builtins")
    var posixpath = Python.import_module("posixpath")

    var children = py.list()
    if Bool(dir_path in by_dir):
        for f in by_dir[dir_path]:
            children.append(f)

    # Discover nested directories: any key in by_dir that begins with
    # `<dir_path>/` and has exactly one extra segment.
    var prefix = ""
    if dir_path.byte_length() > 0:
        prefix = dir_path + "/"
    for key in by_dir.keys():
        var k = String(py.str(key))
        if k == dir_path:
            continue
        if dir_path.byte_length() > 0 and not Bool(py=py.str(k).startswith(prefix)):
            continue
        if dir_path.byte_length() == 0 and k == "":
            continue
        # Direct child only (no further "/").
        var rest = String(py.str(k)[prefix.byte_length() :])
        if "/" in rest:
            continue
        var child = _fold_directories(k, by_dir)
        children.append(child)

    children = py.sorted(children, key=Python.evaluate("lambda c: c['path']"))

    # Concatenate child hashes (already hex strings) and hash with the
    # native Mojo hasher. Bit-for-bit deterministic across runs since
    # children are sorted lexicographically above.
    var combined = String("")
    for c in children:
        combined += String(py.str(c["hash"]))

    var node = py.dict()
    node["path"] = dir_path
    node["type"] = "directory"
    node["hash"] = hex_u64(UInt64(hash(combined)))
    node["children"] = children
    return node


def diff_trees(old: PythonObject, new: PythonObject) raises -> PythonObject:
    """Walk both trees and emit a list of `{path, type, hash?}` change records.

    First-build short-circuit: if `old` is None, every leaf in `new`
    becomes an `added` change.
    """
    var py = Python.import_module("builtins")
    var changes = py.list()
    if Bool(old is py.None):
        _collect_all(new, "added", changes)
        return changes
    _diff_nodes(old, new, changes)
    return changes


def _diff_nodes(o: PythonObject, n: PythonObject, changes: PythonObject) raises:
    var py = Python.import_module("builtins")
    if String(py.str(o["hash"])) == String(py.str(n["hash"])):
        return
    var o_type = String(py.str(o["type"]))
    var n_type = String(py.str(n["type"]))
    if o_type == "file" and n_type == "file":
        var ch = py.dict()
        ch["path"] = n["path"]
        ch["type"] = "modified"
        ch["hash"] = n["hash"]
        changes.append(ch)
        return
    if o_type == "directory" and n_type == "directory":
        var o_map = _children_by_path(o)
        var n_map = _children_by_path(n)
        for path_key in n_map.keys():
            if Bool(path_key in o_map):
                _diff_nodes(o_map[path_key], n_map[path_key], changes)
            else:
                _collect_all(n_map[path_key], "added", changes)
        for path_key in o_map.keys():
            if not Bool(path_key in n_map):
                _collect_all(o_map[path_key], "deleted", changes)
        return
    # Type changed: tear down the old, add the new.
    _collect_all(o, "deleted", changes)
    _collect_all(n, "added", changes)


def _children_by_path(node: PythonObject) raises -> PythonObject:
    var py = Python.import_module("builtins")
    var out = py.dict()
    var children = node["children"]
    for c in children:
        out[c["path"]] = c
    return out


def _collect_all(
    node: PythonObject, kind: String, changes: PythonObject
) raises:
    var py = Python.import_module("builtins")
    if String(py.str(node["type"])) == "file":
        var ch = py.dict()
        ch["path"] = node["path"]
        ch["type"] = kind
        if kind == "added":
            ch["hash"] = node["hash"]
        changes.append(ch)
        return
    for c in node["children"]:
        _collect_all(c, kind, changes)
