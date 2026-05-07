import type { FileProfile } from "./types";

/**
 * Built-in file profiles used by `vgrep init` to scaffold `.vgrep/config.json`.
 *
 * The actual matching (extension / filename → indexable?) happens inside the
 * Mojo sidecar; this object is only used by the CLI to seed config and show
 * the user the available profile names.
 */
export const DEFAULT_FILE_PROFILES: Record<string, FileProfile> = {
  code: {
    description:
      "Programming language source files and code-adjacent build/query files.",
    extensions: [
      "ts", "tsx", "js", "jsx", "mjs", "cjs",
      "py", "pyi",
      "go", "rs",
      "java", "kt",
      "c", "h", "cpp", "cxx", "cc", "hpp",
      "cs",
      "rb", "php", "swift",
      "sh", "bash", "zsh",
      "sql", "graphql", "gql", "proto", "gradle", "dockerfile",
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
      "json", "jsonc", "yaml", "yml", "toml", "xml",
      "csv", "tsv", "properties", "ini", "env",
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
 * Resolve the active profile set into the flat extension + filename lists
 * the sidecar's `open` request expects.
 */
export function resolveProfileFilters(
  activeProfiles: string[],
  profiles: Record<string, FileProfile>,
): { extensions: string[]; filenames: string[] } {
  const extensions = new Set<string>();
  const filenames = new Set<string>();
  for (const name of activeProfiles) {
    const profile = profiles[name];
    if (!profile) continue;
    for (const ext of profile.extensions) {
      extensions.add(ext.replace(/^\./, "").toLowerCase());
    }
    for (const fn of profile.filenames ?? []) {
      filenames.add(fn.toLowerCase());
    }
  }
  return {
    extensions: [...extensions],
    filenames: [...filenames],
  };
}
