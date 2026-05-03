import type { CodeChunk } from "../types";
import {
  detectLanguage,
  getTopLevelTypes,
  hasGrammar,
  createParser,
} from "./languages";

// ─── Tunable constants ─────────────────────────────────────────

/** Maximum number of lines per chunk. Oversized chunks are subdivided. */
const MAX_CHUNK_LINES = 60;

/** Minimum number of lines per chunk. Tiny chunks are merged with the next. */
const MIN_CHUNK_LINES = 4;

/** Sliding window step size (lines) when falling back to window-based chunking. */
const WINDOW_STEP = 40;

// ─── Public API ────────────────────────────────────────────────

/**
 * Split a source file into semantic code chunks using Tree-sitter.
 *
 * Strategy:
 *   1. For supported languages: parse the AST with Tree-sitter, extract
 *      top-level declarations (functions, classes, methods, etc.),
 *      and group remaining lines into preamble/interstitial chunks.
 *   2. For unsupported languages or parse failures: fall back to
 *      a pure sliding window.
 *   3. Post-process: merge tiny chunks, subdivide oversized ones.
 *
 * Each chunk gets a SHA-256 content hash for deduplication and cache keying.
 *
 * @param filePath - Relative path from project root (e.g. "src/utils.ts")
 * @param content  - Raw text content of the file
 * @returns Array of CodeChunks ready for embedding
 */
export async function chunkFile(
  filePath: string,
  content: string,
): Promise<CodeChunk[]> {
  const lines = content.split("\n");

  // Skip empty or very small files
  if (lines.length < MIN_CHUNK_LINES) {
    if (content.trim().length === 0) return [];
    return [makeChunk(filePath, lines, 1, detectLanguage(filePath))];
  }

  const language = detectLanguage(filePath);

  // Try Tree-sitter AST-based chunking for supported languages
  if (language && hasGrammar(language)) {
    const astChunks = await chunkWithTreeSitter(
      filePath,
      content,
      lines,
      language,
    );
    if (astChunks) return astChunks;
  }

  // Fallback: sliding window
  const rawChunks = slidingWindow(lines);
  const processed = postProcess(rawChunks, lines);
  return processed.map(({ startLine, endLine }) => {
    const chunkLines = lines.slice(startLine - 1, endLine);
    return makeChunk(filePath, chunkLines, startLine, language);
  });
}

// ─── Tree-sitter chunking ──────────────────────────────────────

/**
 * Extract semantic chunks from a file using Tree-sitter AST.
 *
 * Walks the AST's top-level children. When a child is a recognized
 * declaration type (function, class, etc.), it becomes its own chunk.
 * Non-declaration nodes (imports, comments, loose statements) are
 * grouped together into "preamble" or "interstitial" chunks.
 *
 * Returns null if Tree-sitter parsing fails (→ caller falls back).
 */
async function chunkWithTreeSitter(
  filePath: string,
  content: string,
  lines: string[],
  language: string,
): Promise<CodeChunk[] | null> {
  const parser = await createParser(language);
  if (!parser) return null;

  const tree = parser.parse(content);
  if (!tree) {
    parser.delete();
    return null;
  }

  const topTypes = new Set(getTopLevelTypes(language));
  const rootNode = tree.rootNode;

  // Collect boundary ranges from top-level declarations
  const ranges: { startLine: number; endLine: number; isDecl: boolean }[] = [];
  let gatherStart = 0; // Start of current non-declaration region

  for (let i = 0; i < rootNode.childCount; i++) {
    const child = rootNode.child(i)!;
    const childStart = child.startPosition.row; // 0-indexed
    const childEnd = child.endPosition.row;

    if (topTypes.has(child.type)) {
      // The declaration itself (include a directly adjacent leading comment).
      let declStart = childStart;
      const prevSibling = child.previousNamedSibling;
      if (
        prevSibling &&
        prevSibling.type === "comment" &&
        prevSibling.endPosition.row === childStart - 1
      ) {
        declStart = prevSibling.startPosition.row;
      }

      // If there's a gap of non-declaration code before this declaration,
      // collect it without duplicating a leading comment attached above.
      if (declStart > gatherStart) {
        ranges.push({
          startLine: gatherStart + 1,
          endLine: declStart,
          isDecl: false,
        });
      }

      ranges.push({
        startLine: declStart + 1, // 1-indexed
        endLine: childEnd + 1,
        isDecl: true,
      });

      gatherStart = childEnd + 1;
    }
  }

  // Collect any trailing non-declaration code
  if (gatherStart < lines.length) {
    ranges.push({
      startLine: gatherStart + 1,
      endLine: lines.length,
      isDecl: false,
    });
  }

  // If we found no declarations at all, return null → fallback
  if (!ranges.some((r) => r.isDecl)) {
    parser.delete();
    if (tree) tree.delete();
    return null;
  }

  // Filter out empty ranges + post-process
  const validRanges = ranges.filter((r) => {
    const chunkLines = lines.slice(r.startLine - 1, r.endLine);
    return chunkLines.some((l) => l.trim().length > 0);
  });

  const processed = postProcess(
    validRanges.map((r) => ({ startLine: r.startLine, endLine: r.endLine })),
    lines,
  );

  const chunks = processed.map(({ startLine, endLine }) => {
    const chunkLines = lines.slice(startLine - 1, endLine);
    return makeChunk(filePath, chunkLines, startLine, language);
  });

  // Cleanup tree-sitter objects
  parser.delete();
  if (tree) tree.delete();

  return chunks;
}

// ─── Sliding window (fallback) ─────────────────────────────────

/**
 * Pure sliding window chunking for non-code files or fallback.
 */
function slidingWindow(
  lines: string[],
): { startLine: number; endLine: number }[] {
  const chunks: { startLine: number; endLine: number }[] = [];

  for (let i = 0; i < lines.length; i += WINDOW_STEP) {
    const start = i;
    const end = Math.min(i + MAX_CHUNK_LINES - 1, lines.length - 1);

    chunks.push({
      startLine: start + 1,
      endLine: end + 1,
    });

    // Stop if we've reached the end
    if (end >= lines.length - 1) break;
  }

  return chunks;
}

// ─── Post-processing ───────────────────────────────────────────

/**
 * Merge tiny chunks and subdivide oversized ones.
 */
function postProcess(
  chunks: { startLine: number; endLine: number }[],
  lines: string[],
): { startLine: number; endLine: number }[] {
  const result: { startLine: number; endLine: number }[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { startLine, endLine } = chunks[i]!;
    const chunkSize = endLine - startLine + 1;

    if (chunkSize > MAX_CHUNK_LINES) {
      // Subdivide with sliding window
      const subLines = lines.slice(startLine - 1, endLine);
      const subChunks = slidingWindow(subLines);
      for (const sub of subChunks) {
        result.push({
          startLine: startLine + sub.startLine - 1,
          endLine: startLine + sub.endLine - 1,
        });
      }
    } else if (chunkSize < MIN_CHUNK_LINES && result.length > 0) {
      // Merge with previous chunk (extend its endLine)
      result[result.length - 1]!.endLine = endLine;
    } else {
      result.push({ startLine, endLine });
    }
  }

  return result;
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Create a CodeChunk from a slice of lines.
 */
function makeChunk(
  filePath: string,
  chunkLines: string[],
  startLine: number,
  language?: string,
): CodeChunk {
  const content = chunkLines.join("\n");
  const chunkHash = Bun.CryptoHasher.hash("sha256", content, "hex");

  return {
    filePath,
    chunkHash,
    content,
    startLine,
    endLine: startLine + chunkLines.length - 1,
    language,
  };
}

// Re-export initTreeSitter for consumers that need explicit init
export { initTreeSitter } from "./languages";
