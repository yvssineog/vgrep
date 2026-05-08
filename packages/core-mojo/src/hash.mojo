"""Native Mojo file hashing.

Hash + I/O are both native Mojo:
  - `std.pathlib.Path.read_text()` for the file read
  - `std.hashlib.hash` for the digest (fast non-cryptographic hash)
  - `std.algorithm.parallelize` for cross-core fan-out

We don't need preimage resistance — the merkle tree only needs stable
keys for change detection. Switching off SHA-256 means existing
`.vgrep/merkle.json` files don't match new hashes, so the first run
after upgrading reindexes from scratch.

The previous implementation pinned hashing to Python's `hashlib.sha256`
because it gave us SHA-NI / ARMv8 acceleration for free. The trade-
off: every worker had to cross the Python boundary, so we couldn't
use Mojo's native `parallelize` (libpython aborts under multiple
worker threads holding Python objects). Now that hashing is in pure
Mojo and reads go through `std.pathlib`, parallelize is safe and the
worker pool is one stdlib call away.

Hashes are emitted as 16-char lowercase hex (UInt64 → hex). The
SQLite store keys on this string, so width doesn't matter as long
as it's stable.
"""

from std.algorithm import parallelize
from std.hashlib.hash import hash
from std.os.path import join
from std.pathlib import Path


@fieldwise_init
struct FileHash(Copyable, Movable):
    var rel_path: String
    var hex: String
    var size: Int
    var mtime_ms: Int


def hex_u64(value: UInt64) -> String:
    """Format a 64-bit hash as 16 lowercase hex chars."""
    var digits: StaticString = "0123456789abcdef"
    var out = String("")
    var i = 16
    while i > 0:
        i -= 1
        var shift = UInt64(i * 4)
        var nibble = Int((value >> shift) & UInt64(15))
        out += String(digits[byte=nibble])
    return out^


def hash_one(project_root: String, rel: String) raises -> String:
    """Hex hash of one file's contents."""
    var abs_path = join(project_root, rel)
    var content = Path(abs_path).read_text()
    return hex_u64(UInt64(hash(content)))


def hash_many(
    project_root: String,
    paths: List[String],
    sizes: List[Int],
    mtimes: List[Int],
) raises -> List[FileHash]:
    """Hash a batch of files in parallel."""
    var n = paths.__len__()
    if n == 0:
        return List[FileHash]()

    # Pre-allocate result slots so workers can fill in by index without
    # touching shared metadata. Empty string == "this file failed".
    var hexes = List[String]()
    for _ in range(n):
        hexes.append(String(""))

    @parameter
    def worker(i: Int):
        try:
            var abs_path = join(project_root, paths[i])
            var content = Path(abs_path).read_text()
            hexes[i] = hex_u64(UInt64(hash(content)))
        except:
            # Leave the slot empty; the assembly loop below skips it.
            pass

    parallelize[worker](n)

    var out = List[FileHash]()
    for i in range(n):
        if hexes[i].byte_length() > 0:
            out.append(FileHash(
                rel_path=paths[i],
                hex=hexes[i].copy(),
                size=sizes[i],
                mtime_ms=mtimes[i],
            ))
    return out^
