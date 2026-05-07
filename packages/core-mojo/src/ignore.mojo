"""`.vgrepignore` matcher — pure Mojo.

Two buckets keep the hot file-walk path cheap:
  - `exact_names` : plain names like `node_modules` / `.env`. A path
                    matches if any segment equals one of these.
  - `glob_lines`  : anything containing glob metacharacters; we run
                    them through a small native `*` / `?` matcher
                    (no Python `fnmatch`; trivial to do in Mojo).

The walker hits this matcher once per file path — orders of magnitude
more often than the embedder, so even a couple of micros saved per
match adds up across a large repo.
"""


@fieldwise_init
struct IgnoreRules(Copyable, Movable):
    var exact_names: List[String]
    var glob_lines: List[String]


def empty_ignore() -> IgnoreRules:
    return IgnoreRules(exact_names=List[String](), glob_lines=List[String]())


def has_glob_meta(line: String) -> Bool:
    return ("*" in line) or ("?" in line) or ("[" in line) or ("{" in line)


def parse_ignore_text(text: String) raises -> IgnoreRules:
    var rules = empty_ignore()
    var lines = text.split("\n")
    for raw_ref in lines:
        var raw: String = String(String(raw_ref).strip())
        if raw.byte_length() == 0:
            continue
        if String(raw[byte=0]) == "#":
            continue
        var pn = raw.byte_length()
        var pattern: String
        if pn > 0 and String(raw[byte = pn - 1]) == "/":
            pattern = String(raw[byte=0 : pn - 1])
        else:
            pattern = raw
        if has_glob_meta(pattern):
            rules.glob_lines.append(pattern)
        else:
            rules.exact_names.append(pattern)
    return rules^


def basename_of(rel: String) -> String:
    """Return the last path segment (POSIX) of `rel`."""
    var n = rel.byte_length()
    var i = n - 1
    while i >= 0:
        if String(rel[byte=i]) == "/":
            return String(rel[byte=i + 1 : n])
        i -= 1
    return rel


def matches_ignore(rules: IgnoreRules, rel: String) -> Bool:
    """True if `rel` is excluded by the loaded `.vgrepignore` rules."""
    var name = basename_of(rel)

    # Exact-name bucket: full path, basename, or any path segment match.
    for n in rules.exact_names:
        if String(n) == name or String(n) == rel:
            return True
    var segments = rel.split("/")
    for seg_ref in segments:
        var seg = String(seg_ref)
        for n in rules.exact_names:
            if String(n) == seg:
                return True

    # Glob bucket: try basename first (cheaper) then full path.
    for g in rules.glob_lines:
        var pattern = String(g)
        if glob_match(pattern, name) or glob_match(pattern, rel):
            return True
    return False


def glob_match(pattern: String, text: String) -> Bool:
    """Tiny `*`/`?` matcher. Doesn't implement bracket classes — none
    of the default `.vgrepignore` patterns use them, and skipping a
    file that does will fall back to scanning it (cheaper than a
    bug from a buggy parser)."""
    return _glob_recursive(pattern, 0, text, 0)


def _glob_recursive(p: String, pi: Int, t: String, ti: Int) -> Bool:
    var pn = p.byte_length()
    var tn = t.byte_length()
    var i = pi
    var j = ti
    while i < pn:
        var ch = String(p[byte=i])
        if ch == "*":
            # Skip consecutive stars.
            while i < pn and String(p[byte=i]) == "*":
                i += 1
            if i == pn:
                return True
            # Try matching the rest at every position.
            while j <= tn:
                if _glob_recursive(p, i, t, j):
                    return True
                j += 1
            return False
        if j >= tn:
            return False
        var tch = String(t[byte=j])
        if ch == "?" or ch == tch:
            i += 1
            j += 1
            continue
        return False
    return j == tn
