/**
 * Language detection and Tree-sitter grammar management.
 *
 * Maps file extensions to language identifiers, and provides
 * the AST node types that represent "top-level declarations"
 * (functions, classes, methods, etc.) for each language.
 *
 * Uses `tree-sitter-wasms` for prebuilt WASM grammar files.
 */

import Parser from "web-tree-sitter";
import { join, dirname } from "node:path";
import type { FileProfile } from "../types";

// ─── Extension → Language mapping ──────────────────────────────

const EXTENSION_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  // Python
  py: "python",
  pyi: "python",

  // Go
  go: "go",

  // Rust
  rs: "rust",

  // Java / Kotlin
  java: "java",
  kt: "kotlin",

  // C / C++
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",

  // C#
  cs: "c_sharp",

  // Ruby
  rb: "ruby",

  // PHP
  php: "php",

  // Swift
  swift: "swift",

  // Shell
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

export const DEFAULT_FILE_PROFILES: Record<string, FileProfile> = {
  code: {
    description: "Programming language source files and code-adjacent build/query files.",
    extensions: [
      ...Object.keys(EXTENSION_MAP),
      "sql",
      "graphql",
      "gql",
      "proto",
      "gradle",
      "dockerfile",
    ],
    filenames: ["dockerfile", "makefile", "rakefile", "gemfile"],
  },
  docs: {
    description: "Documentation and prose files.",
    extensions: ["md", "mdx", "txt", "rst", "adoc"],
    filenames: ["readme", "license", "changelog"],
  },
  data: {
    description: "Structured data and configuration files.",
    extensions: [
      "json",
      "jsonc",
      "yaml",
      "yml",
      "toml",
      "xml",
      "csv",
      "tsv",
      "properties",
      "ini",
      "env",
    ],
    filenames: [],
  },
  styles: {
    description: "Stylesheets and UI styling files.",
    extensions: ["css", "scss", "sass", "less", "pcss"],
    filenames: [],
  },
};

/**
 * Detect language from a file path by extension.
 * Returns `undefined` for unknown extensions.
 */
export function detectLanguage(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? EXTENSION_MAP[ext] : undefined;
}

/**
 * Return whether a file should be indexed with the default code profile.
 */
export function isIndexableTextFile(filePath: string): boolean {
  return createIndexableFileMatcher(["code"], DEFAULT_FILE_PROFILES)(filePath);
}

export function createIndexableFileMatcher(
  profileNames: string[],
  profiles: Record<string, FileProfile>,
): (filePath: string) => boolean {
  const extensions = new Set<string>();
  const filenames = new Set<string>();

  for (const profileName of profileNames) {
    const profile = profiles[profileName];
    if (!profile) continue;

    for (const extension of profile.extensions) {
      extensions.add(normalizeExtension(extension));
    }
    for (const filename of profile.filenames ?? []) {
      filenames.add(filename.toLowerCase());
    }
  }

  return (filePath: string) => {
    const baseName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (filenames.has(baseName)) return true;

    const ext = baseName.includes(".") ? baseName.split(".").pop() : baseName;
    return ext ? extensions.has(normalizeExtension(ext)) : false;
  };
}

function normalizeExtension(extension: string): string {
  return extension.replace(/^\./, "").toLowerCase();
}


// ─── AST node types per language ───────────────────────────────

/**
 * Node types that represent top-level "chunks" worth extracting.
 * These are the AST node types that Tree-sitter produces for
 * function declarations, class declarations, etc.
 */
const TOP_LEVEL_TYPES: Record<string, string[]> = {
  typescript: [
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration", // const/let/var
    "method_definition",
  ],
  tsx: [
    "function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration",
    "method_definition",
  ],
  javascript: [
    "function_declaration",
    "class_declaration",
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "method_definition",
  ],
  python: [
    "function_definition",
    "class_definition",
    "decorated_definition",
  ],
  go: [
    "function_declaration",
    "method_declaration",
    "type_declaration",
  ],
  rust: [
    "function_item",
    "impl_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "mod_item",
  ],
  java: [
    "method_declaration",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "constructor_declaration",
  ],
  kotlin: [
    "function_declaration",
    "class_declaration",
    "object_declaration",
  ],
  c: [
    "function_definition",
    "struct_specifier",
    "enum_specifier",
    "declaration",
  ],
  cpp: [
    "function_definition",
    "class_specifier",
    "struct_specifier",
    "enum_specifier",
    "namespace_definition",
    "template_declaration",
  ],
  c_sharp: [
    "method_declaration",
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "enum_declaration",
  ],
  ruby: [
    "method",
    "class",
    "module",
    "singleton_method",
  ],
  php: [
    "function_definition",
    "class_declaration",
    "method_declaration",
    "interface_declaration",
    "trait_declaration",
  ],
  bash: [
    "function_definition",
  ],
};

/**
 * Get the AST node types considered as top-level declaration boundaries.
 */
export function getTopLevelTypes(language: string): string[] {
  return TOP_LEVEL_TYPES[language] ?? [];
}

/**
 * Check if a language has tree-sitter grammar support.
 */
export function hasGrammar(language: string): boolean {
  return language in TOP_LEVEL_TYPES;
}

// ─── Parser initialization ─────────────────────────────────────

let initialized = false;
const loadedLanguages = new Map<string, Parser.Language>();

/**
 * Initialize the Tree-sitter WASM runtime.
 * Must be called once before any parsing. Safe to call multiple times.
 */
export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

/**
 * Resolve the path to a tree-sitter WASM grammar file.
 * Uses the `tree-sitter-wasms` package which bundles prebuilt grammars.
 */
function resolveWasmPath(language: string): string {
  // tree-sitter-wasms provides files as tree-sitter-<lang>.wasm
  const wasmDir = dirname(require.resolve("tree-sitter-wasms/package.json"));
  return join(wasmDir, "out", `tree-sitter-${language}.wasm`);
}

/**
 * Load a Tree-sitter language grammar (cached).
 * Returns null if the grammar WASM file is not available.
 */
export async function loadLanguage(
  language: string,
): Promise<Parser.Language | null> {
  if (loadedLanguages.has(language)) {
    return loadedLanguages.get(language)!;
  }

  try {
    await initTreeSitter();
    const wasmPath = resolveWasmPath(language);
    const lang = await Parser.Language.load(wasmPath);
    loadedLanguages.set(language, lang);
    return lang;
  } catch {
    // Grammar not available — fallback to sliding window
    return null;
  }
}

/**
 * Create a parser instance for a given language.
 * Returns null if the language grammar can't be loaded.
 */
export async function createParser(
  language: string,
): Promise<Parser | null> {
  const lang = await loadLanguage(language);
  if (!lang) return null;

  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

