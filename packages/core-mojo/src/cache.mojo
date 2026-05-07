"""Per-chunk embedding cache, file-per-hash.

Skipping a single embedding call dwarfs a disk read, so we keep the
cache as small flat files: `<cache_dir>/<chunkhash>.bin`, each one
holding the vector as a little-endian float32 stream.

The hash key is the SHA-256 of the chunk content, so as long as the
content (and chunking algorithm) hasn't changed, we get the same key
across runs — re-indexing a million-line repo with no real change is
effectively free.

This module is pure Mojo: `Path.read_bytes()` / `write_bytes()` plus
`UnsafePointer.bitcast` to round-trip between bytes and Float32.
"""

from std.os import makedirs
from std.os.path import exists
from std.pathlib import Path
from std.memory import UnsafePointer


def cache_path(cache_dir: String, chunk_hash: String) -> String:
    return cache_dir + "/" + chunk_hash + ".bin"


def read_cached(cache_dir: String, chunk_hash: String, dim: Int) raises -> List[Float32]:
    """Return the cached vector or an empty list if absent / corrupt."""
    var path_s = cache_path(cache_dir, chunk_hash)
    if not exists(path_s):
        return List[Float32]()
    var bytes_data = Path(path_s).read_bytes()
    var byte_len = len(bytes_data)
    if byte_len != dim * 4:
        return List[Float32]()
    # Reinterpret the byte buffer as Float32 lanes.
    var ptr = bytes_data.unsafe_ptr().bitcast[Float32]()
    var out = List[Float32]()
    for i in range(dim):
        out.append(ptr[i])
    return out^


def write_cached(cache_dir: String, chunk_hash: String, vec: List[Float32]) raises:
    if not exists(cache_dir):
        makedirs(cache_dir, exist_ok=True)
    var n = vec.__len__()
    var bytes_data = List[UInt8]()
    for _ in range(n * 4):
        bytes_data.append(0)
    var dst = bytes_data.unsafe_ptr().bitcast[Float32]()
    for i in range(n):
        dst[i] = vec[i]
    Path(cache_path(cache_dir, chunk_hash)).write_bytes(bytes_data)
