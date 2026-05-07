"""Recursive file walk — pure Mojo via `std.os.listdir`.

Replaces the previous `os.walk` Python wrapper. The walker prunes
ignored directories before descending so we never touch
`node_modules`, `.git`, `.vgrep`, etc — same effect as the prior
TS `Bun.Glob` walker but without crossing the FFI boundary.

We don't use Mojo's `stat_result.st_mtime` (the field exists on the
struct's printer but isn't accessible as an attribute in 1.0.0b1),
so file mtimes are pulled via Python `os.path.getmtime` — the only
Python interop in this module.
"""

from std.python import PythonObject, Python
from std.os import listdir
from std.os.path import join, isdir, isfile, getsize

from ignore import IgnoreRules, matches_ignore


@fieldwise_init
struct FileEntry(Copyable, Movable):
    """One file discovered by the walker."""
    var rel_path: String
    var size: Int
    var mtime_ms: Int


@fieldwise_init
struct Profile(Copyable, Movable):
    """A subset of `VgrepConfig.fileProfiles` — extension + filename match."""
    var extensions: List[String]
    var filenames: List[String]


def _last_segment_lower(path: String) -> String:
    var n = path.byte_length()
    var i = n - 1
    while i >= 0:
        if String(path[byte=i]) == "/":
            return String(path[byte=i + 1 : n]).lower()
        i -= 1
    return path.lower()


def _ext_of(name_lower: String) -> String:
    """Last `.foo` segment of a basename, without the dot. Empty if none."""
    var n = name_lower.byte_length()
    var i = n - 1
    while i >= 0:
        if String(name_lower[byte=i]) == ".":
            return String(name_lower[byte=i + 1 : n])
        i -= 1
    return name_lower


def is_indexable(profile: Profile, rel: String) -> Bool:
    """Match the same rules as the TS `createIndexableFileMatcher`."""
    var basename = _last_segment_lower(rel)
    for fn_ref in profile.filenames:
        if String(fn_ref).lower() == basename:
            return True
    var ext = _ext_of(basename)
    for e_ref in profile.extensions:
        if String(e_ref).lower() == ext:
            return True
    return False


def _mtime_ms(abs_path: String) raises -> Int:
    """File modification time in epoch ms — uses Python because Mojo's
    `stat_result.st_mtime` isn't accessible as an attribute in 1.0.0b1."""
    var os = Python.import_module("os")
    var t = os.path.getmtime(abs_path)
    return Int(py=Python.import_module("builtins").int(t * 1000))


def walk(
    project_root: String,
    profile: Profile,
    rules: IgnoreRules,
) raises -> List[FileEntry]:
    """Yield every indexable file under `project_root` as a flat list."""
    var out = List[FileEntry]()
    _walk_recursive(project_root, "", profile, rules, out)
    return out^


def _walk_recursive(
    project_root: String,
    rel_dir: String,
    profile: Profile,
    rules: IgnoreRules,
    mut out: List[FileEntry],
) raises:
    var abs_dir: String
    if rel_dir.byte_length() == 0:
        abs_dir = project_root
    else:
        abs_dir = join(project_root, rel_dir)
    var entries = listdir(abs_dir)
    for entry_ref in entries:
        var name = String(entry_ref)
        var rel: String
        if rel_dir.byte_length() == 0:
            rel = name
        else:
            rel = rel_dir + "/" + name
        if matches_ignore(rules, rel):
            continue
        var abs = join(abs_dir, name)
        if isdir(abs):
            _walk_recursive(project_root, rel, profile, rules, out)
            continue
        if not isfile(abs):
            continue
        if not is_indexable(profile, rel):
            continue
        out.append(FileEntry(
            rel_path=rel,
            size=getsize(abs),
            mtime_ms=_mtime_ms(abs),
        ))
