import { createHash } from "node:crypto";

/**
 * Compute a 64-bit Simhash from a collection of file content hashes.
 *
 * The simhash is a locality-sensitive fingerprint: repositories with
 * mostly identical files will have simhashes with a small Hamming distance,
 * enabling fuzzy matching in the cloud backend.
 *
 * Algorithm:
 * 1. For each file hash string, compute a 64-bit feature hash.
 * 2. Maintain a 64-element accumulator of weighted bits (+1/-1).
 * 3. Threshold each accumulator position to produce the final 64-bit value.
 *
 * @param fileHashes - Array of SHA-256 hex strings (one per file)
 * @returns 64-bit simhash as a hex string (16 chars)
 */
export function computeSimhash(fileHashes: string[]): string {
  if (fileHashes.length === 0) {
    return "0000000000000000";
  }

  // 64-bit accumulator
  const bits = new Int32Array(64);

  for (const hash of fileHashes) {
    // Get a 64-bit feature from the file hash
    const featureHash = hash64(hash);

    for (let i = 0; i < 64; i++) {
      // Extract bit i from the feature hash
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      const bit = (featureHash[byteIndex] >> bitIndex) & 1;

      bits[i] += bit === 1 ? 1 : -1;
    }
  }

  // Threshold to produce final simhash
  const result = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (bits[i] > 0) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      result[byteIndex] |= 1 << bitIndex;
    }
  }

  return Buffer.from(result).toString("hex");
}

/**
 * Compute the Hamming distance between two simhashes.
 * Returns the number of differing bits (0–64).
 *
 * @param a - First simhash (hex string, 16 chars)
 * @param b - Second simhash (hex string, 16 chars)
 */
export function hammingDistance(a: string, b: string): number {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  let distance = 0;

  for (let i = 0; i < 8; i++) {
    let xor = bufA[i] ^ bufB[i];
    // Count set bits (Brian Kernighan's method)
    while (xor) {
      distance++;
      xor &= xor - 1;
    }
  }

  return distance;
}

/**
 * Produce a 64-bit (8-byte) hash from an input string
 * by taking the first 8 bytes of SHA-256.
 */
function hash64(input: string): Uint8Array {
  const full = createHash("sha256").update(input).digest();
  return new Uint8Array(full.buffer, full.byteOffset, 8);
}
