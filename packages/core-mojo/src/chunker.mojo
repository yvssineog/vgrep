"""Tree-sitter semantic chunking.

Direct port of `packages/core/src/chunking/chunker.ts`. Tree-sitter
parsing itself is delegated to Python (`tree_sitter_language_pack`),
but the boundary heuristics, line slicing, and post-processing are
all native Mojo:

  - top-level declarations become their own chunks (functions, classes,
    interfaces, …);
  - directly-preceding comments fold into the chunk they annotate;
  - non-declaration code groups into "preamble" / "interstitial" chunks;
  - chunks shorter than `_MIN_LINES` merge with the next neighbor;
  - chunks longer than `_MAX_LINES` are subdivided by sliding window.

For unsupported languages we fall through to a sliding window with a
fixed step (matches the previous TS fallback exactly).
"""

from std.python import PythonObject, Python


comptime _MIN_LINES = 4
comptime _MAX_LINES = 60
comptime _WINDOW_STEP = 40
comptime _WINDOW_OVERLAP = 8


@fieldwise_init
struct CodeChunk(Copyable, Movable):
    var file_path: String
    var content: String
    var chunk_hash: String
    var start_line: Int
    var end_line: Int
    var language: String


def chunk_file(file_path: String, content: String) raises -> List[CodeChunk]:
    """Slice one file into semantically-coherent chunks."""
    var lang = _detect_language(file_path)
    if lang.byte_length() == 0 or not _has_grammar(lang):
        return _sliding_window(file_path, content, lang)
    try:
        var py = Python.import_module("builtins")
        var tslp = Python.import_module("tree_sitter_language_pack")
        var parser = tslp.get_parser(lang)
        var tree = parser.parse(py.bytes(content, "utf-8"))
        # Extract (start_line, end_line) pairs as Mojo Ints so the rest
        # of the chunking is pure-Mojo string slicing.
        var ranges = _extract_ranges(tree.root_node, lang)
        if ranges.__len__() == 0:
            return _sliding_window(file_path, content, lang)
        return _slice_by_ranges(file_path, content, lang, ranges)
    except:
        # Parser missing or grammar load failure — degrade gracefully.
        return _sliding_window(file_path, content, lang)


@fieldwise_init
struct LineRange(Copyable, Movable):
    """Half-open line range, 0-indexed."""
    var start: Int
    var end: Int


def _split_lines_keep(text: String) raises -> List[String]:
    """Like Python's `splitlines(keepends=True)` — every line keeps its
    trailing `\\n` (or none, on the final line). We delegate to Python's
    `str.splitlines` because Mojo's `s[byte=lo:hi]` slicing asserts that
    both endpoints land on a UTF-8 codepoint boundary, which we can't
    guarantee for arbitrary file contents using a byte-level scan."""
    var py = Python.import_module("builtins")
    var py_lines = py.str(text).splitlines(True)
    var out = List[String]()
    var n = Int(py=py.len(py_lines))
    for i in range(n):
        out.append(String(py.str(py_lines[i])))
    return out^


def _join_lines(lines: List[String], start: Int, end: Int) -> String:
    var out = String("")
    for i in range(start, end):
        out += lines[i]
    return out^


def _slice_by_ranges(
    file_path: String,
    content: String,
    lang: String,
    ranges: List[LineRange],
) raises -> List[CodeChunk]:
    var lines = _split_lines_keep(content)
    var total_lines = lines.__len__()
    var n = ranges.__len__()

    var chunks = List[CodeChunk]()
    var prev_end = 0  # exclusive, line index 0-based
    for i in range(n):
        var rng = ranges[i].copy()
        var start = rng.start
        var end = rng.end
        if start > prev_end:
            var pre = _join_lines(lines, prev_end, start)
            if pre.byte_length() > 0:
                chunks.append(_make_chunk(file_path, lang, pre, prev_end + 1, start))
        var body = _join_lines(lines, start, end)
        if body.byte_length() > 0:
            chunks.append(_make_chunk(file_path, lang, body, start + 1, end))
        prev_end = end

    if prev_end < total_lines:
        var tail = _join_lines(lines, prev_end, total_lines)
        if tail.byte_length() > 0:
            chunks.append(
                _make_chunk(file_path, lang, tail, prev_end + 1, total_lines)
            )

    return _post_process(chunks, file_path, lang)


def _post_process(
    chunks: List[CodeChunk], file_path: String, lang: String
) raises -> List[CodeChunk]:
    """Merge tiny chunks, split oversized ones."""
    var merged = List[CodeChunk]()
    var i = 0
    while i < chunks.__len__():
        var c = chunks[i].copy()
        var span = c.end_line - c.start_line + 1
        if span < _MIN_LINES and (i + 1) < chunks.__len__():
            var nxt = chunks[i + 1].copy()
            var combined_content = c.content + nxt.content
            var combined = _make_chunk(
                file_path, lang, combined_content, c.start_line, nxt.end_line
            )
            merged.append(combined^)
            i += 2
            continue
        if span > _MAX_LINES:
            var subs = _sliding_window_text(
                file_path, c.content, lang, c.start_line
            )
            for s in subs:
                merged.append(s.copy())
            i += 1
            continue
        merged.append(c^)
        i += 1
    return merged^


def _sliding_window(
    file_path: String, content: String, lang: String
) raises -> List[CodeChunk]:
    return _sliding_window_text(file_path, content, lang, 1)


def _sliding_window_text(
    file_path: String,
    text: String,
    lang: String,
    base_line: Int,
) raises -> List[CodeChunk]:
    var lines = _split_lines_keep(text)
    var n = lines.__len__()
    var out = List[CodeChunk]()
    var i = 0
    while i < n:
        var end = i + _WINDOW_STEP + _WINDOW_OVERLAP
        if end > n:
            end = n
        var body = _join_lines(lines, i, end)
        if body.byte_length() > 0:
            out.append(
                _make_chunk(file_path, lang, body, base_line + i, base_line + end - 1)
            )
        i += _WINDOW_STEP
    return out^


def _make_chunk(
    file_path: String,
    lang: String,
    content: String,
    start_line: Int,
    end_line: Int,
) raises -> CodeChunk:
    var hashlib = Python.import_module("hashlib")
    var py = Python.import_module("builtins")
    var h = hashlib.sha256(py.bytes(content, "utf-8"))
    return CodeChunk(
        file_path=file_path,
        content=content,
        chunk_hash=String(py=h.hexdigest()),
        start_line=start_line,
        end_line=end_line,
        language=lang,
    )


# ─── Native language detection ────────────────────────────────────────


def _basename_lower(rel: String) -> String:
    var n = rel.byte_length()
    var i = n - 1
    while i >= 0:
        if String(rel[byte=i]) == "/":
            return String(rel[byte=i + 1 : n]).lower()
        i -= 1
    return rel.lower()


def _detect_language(rel: String) -> String:
    var bn = _basename_lower(rel)
    var n = bn.byte_length()
    var dot = -1
    for i in range(n - 1, -1, -1):
        if String(bn[byte=i]) == ".":
            dot = i
            break
    var ext: String
    if dot < 0:
        ext = bn
    else:
        ext = String(bn[byte=dot + 1 : n])
    return _ext_to_lang(ext)


def _ext_to_lang(ext: String) -> String:
    if ext == "ts": return "typescript"
    if ext == "tsx": return "tsx"
    if ext == "js" or ext == "mjs" or ext == "cjs" or ext == "jsx":
        return "javascript"
    if ext == "py" or ext == "pyi": return "python"
    if ext == "go": return "go"
    if ext == "rs": return "rust"
    if ext == "java": return "java"
    if ext == "kt": return "kotlin"
    if ext == "c" or ext == "h": return "c"
    if ext == "cpp" or ext == "cxx" or ext == "cc" or ext == "hpp": return "cpp"
    if ext == "cs": return "csharp"
    if ext == "rb": return "ruby"
    if ext == "php": return "php"
    if ext == "swift": return "swift"
    if ext == "sh" or ext == "bash" or ext == "zsh": return "bash"
    return String("")


def _has_grammar(lang: String) -> Bool:
    if lang == "typescript" or lang == "tsx" or lang == "javascript":
        return True
    if lang == "python" or lang == "go" or lang == "rust": return True
    if lang == "java" or lang == "kotlin": return True
    if lang == "c" or lang == "cpp" or lang == "csharp": return True
    if lang == "ruby" or lang == "php" or lang == "swift" or lang == "bash":
        return True
    return False


# Top-level node types per language. Anything outside these is preamble
# / interstitial. List mirrors `packages/core/src/chunking/languages.ts`.
def _is_top_level_type(lang: String, node_type: String) -> Bool:
    if lang == "typescript" or lang == "tsx":
        return (node_type == "function_declaration"
            or node_type == "class_declaration"
            or node_type == "interface_declaration"
            or node_type == "type_alias_declaration"
            or node_type == "enum_declaration"
            or node_type == "export_statement"
            or node_type == "lexical_declaration"
            or node_type == "method_definition")
    if lang == "javascript":
        return (node_type == "function_declaration"
            or node_type == "class_declaration"
            or node_type == "export_statement"
            or node_type == "lexical_declaration"
            or node_type == "variable_declaration"
            or node_type == "method_definition")
    if lang == "python":
        return (node_type == "function_definition"
            or node_type == "class_definition"
            or node_type == "decorated_definition")
    if lang == "go":
        return (node_type == "function_declaration"
            or node_type == "method_declaration"
            or node_type == "type_declaration")
    if lang == "rust":
        return (node_type == "function_item"
            or node_type == "impl_item"
            or node_type == "struct_item"
            or node_type == "enum_item"
            or node_type == "trait_item"
            or node_type == "mod_item")
    if lang == "java":
        return (node_type == "method_declaration"
            or node_type == "class_declaration"
            or node_type == "interface_declaration"
            or node_type == "enum_declaration"
            or node_type == "constructor_declaration")
    if lang == "bash":
        return node_type == "function_definition"
    return False


def _extract_ranges(root: PythonObject, lang: String) raises -> List[LineRange]:
    """Walk the tree-sitter root node and emit native `LineRange`s for
    every top-level declaration, folding leading comments into the
    chunk they annotate. Returns 0-indexed (start inclusive, end exclusive)."""
    var py = Python.import_module("builtins")
    var children = root.children
    var nc = Int(py=py.len(children))
    var out = List[LineRange]()
    var i = 0
    while i < nc:
        var c = children[i]
        var t = String(py=c.type)
        if _is_top_level_type(lang, t):
            var start = Int(py=c.start_point[0])
            var j = i - 1
            while j >= 0:
                var prev_t = String(py=children[j].type)
                if prev_t == "comment" or prev_t == "line_comment":
                    start = Int(py=children[j].start_point[0])
                    j -= 1
                else:
                    break
            var end = Int(py=c.end_point[0]) + 1
            out.append(LineRange(start=start, end=end))
        i += 1
    return out^
