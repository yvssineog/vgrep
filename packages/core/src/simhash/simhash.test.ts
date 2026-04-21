import { describe, test, expect } from "bun:test";
import { computeSimhash, hammingDistance } from "./simhash";

describe("computeSimhash", () => {
  test("should return a 16-char hex string for valid input", () => {
    const hashes = [
      "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    ];

    const simhash = computeSimhash(hashes);

    expect(simhash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("should return zero hash for empty input", () => {
    const simhash = computeSimhash([]);
    expect(simhash).toBe("0000000000000000");
  });

  test("should be deterministic", () => {
    const hashes = [
      "aaaa000000000000000000000000000000000000000000000000000000000000",
      "bbbb000000000000000000000000000000000000000000000000000000000000",
      "cccc000000000000000000000000000000000000000000000000000000000000",
    ];

    const s1 = computeSimhash(hashes);
    const s2 = computeSimhash(hashes);

    expect(s1).toBe(s2);
  });

  test("should produce similar simhashes for similar file sets", () => {
    const baseHashes = Array.from({ length: 100 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );

    const simhash1 = computeSimhash(baseHashes);

    // Change just 2 out of 100 hashes
    const modifiedHashes = [...baseHashes];
    modifiedHashes[50] = "ff".padStart(64, "f");
    modifiedHashes[51] = "ee".padStart(64, "e");

    const simhash2 = computeSimhash(modifiedHashes);

    // Hamming distance should be small (< 10 bits out of 64)
    const distance = hammingDistance(simhash1, simhash2);
    expect(distance).toBeLessThan(10);
  });

  test("should produce different simhashes for very different file sets", () => {
    const hashes1 = Array.from({ length: 50 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const hashes2 = Array.from({ length: 50 }, (_, i) =>
      (i + 1000).toString(16).padStart(64, "0"),
    );

    const simhash1 = computeSimhash(hashes1);
    const simhash2 = computeSimhash(hashes2);

    expect(simhash1).not.toBe(simhash2);
  });
});

describe("hammingDistance", () => {
  test("should return 0 for identical simhashes", () => {
    const hash = "abcdef0123456789";
    expect(hammingDistance(hash, hash)).toBe(0);
  });

  test("should return correct distance for known values", () => {
    // 0x00 vs 0xFF in the first byte = 8 bits different
    const a = "0000000000000000";
    const b = "ff00000000000000";
    expect(hammingDistance(a, b)).toBe(8);
  });

  test("should be symmetric", () => {
    const a = "abcdef0123456789";
    const b = "0123456789abcdef";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  test("should max at 64 for completely opposite hashes", () => {
    const a = "0000000000000000";
    const b = "ffffffffffffffff";
    expect(hammingDistance(a, b)).toBe(64);
  });
});
