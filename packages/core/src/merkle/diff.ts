import type { MerkleNode, ChangedFile } from "../types";

/**
 * Diff two Merkle trees and produce a list of changed files.
 *
 * Walks both trees top-down, only descending into directories
 * whose hashes differ. This is the core optimization that avoids
 * touching unchanged branches.
 *
 * @param oldTree - The previous Merkle tree (or null for first build)
 * @param newTree - The current Merkle tree
 * @returns List of added, modified, and deleted files
 */
export function diffTrees(
  oldTree: MerkleNode | null,
  newTree: MerkleNode,
): ChangedFile[] {
  const changes: ChangedFile[] = [];

  if (!oldTree) {
    // First build — everything is "added"
    collectAll(newTree, "added", changes);
    return changes;
  }

  diffNodes(oldTree, newTree, changes);
  return changes;
}

/**
 * Recursively diff two nodes.
 */
function diffNodes(
  oldNode: MerkleNode,
  newNode: MerkleNode,
  changes: ChangedFile[],
): void {
  // If hashes match, entire subtree is unchanged — skip
  if (oldNode.hash === newNode.hash) {
    return;
  }

  // Both are files — content changed
  if (oldNode.type === "file" && newNode.type === "file") {
    changes.push({
      path: newNode.path,
      type: "modified",
      hash: newNode.hash,
    });
    return;
  }

  // Both are directories — descend and compare children
  if (oldNode.type === "directory" && newNode.type === "directory") {
    const oldMap = buildChildMap(oldNode.children ?? []);
    const newMap = buildChildMap(newNode.children ?? []);

    // Find added and modified entries
    for (const [path, newChild] of newMap) {
      const oldChild = oldMap.get(path);
      if (!oldChild) {
        // New entry — everything under it is "added"
        collectAll(newChild, "added", changes);
      } else {
        // Exists in both — recurse
        diffNodes(oldChild, newChild, changes);
      }
    }

    // Find deleted entries
    for (const [path, oldChild] of oldMap) {
      if (!newMap.has(path)) {
        collectAll(oldChild, "deleted", changes);
      }
    }
    return;
  }

  // Type changed (file → dir or dir → file) — delete old, add new
  collectAll(oldNode, "deleted", changes);
  collectAll(newNode, "added", changes);
}

/**
 * Collect all file paths in a subtree as a specific change type.
 */
function collectAll(
  node: MerkleNode,
  type: "added" | "deleted",
  changes: ChangedFile[],
): void {
  if (node.type === "file") {
    changes.push({
      path: node.path,
      type,
      hash: type === "added" ? node.hash : undefined,
    });
  } else {
    node.children?.forEach((child) => collectAll(child, type, changes));
  }
}

/**
 * Build a map from child path → MerkleNode for O(1) lookup.
 */
function buildChildMap(children: MerkleNode[]): Map<string, MerkleNode> {
  const map = new Map<string, MerkleNode>();
  for (const child of children) {
    map.set(child.path, child);
  }
  return map;
}
