/**
 * Tests for the island feature's recommendation cache:
 * `src/github-scan/engine/runtime/recommendations-store.ts`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evictStale,
  putRecommendation,
  readRecommendations,
  updateRecommendations,
} from "../../src/github-scan/engine/runtime/recommendations-store.js";
import type { Recommendation } from "../../src/github-scan/engine/runtime/types.js";

function makeRec(id: string, summary = `summary for ${id}`): Recommendation {
  return {
    id,
    summary,
    rationale: `rationale for ${id}`,
    action: {
      kind: "comment",
      args: {
        number: 1,
        target: "pr",
        body: `body for ${id}`,
      },
    },
    generated_at: 1_700_000_000,
    model: "claude-test",
    input_hash: `hash-${id}`,
  };
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "rec-store-"));
}

describe("readRecommendations", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkTmp();
    path = join(dir, "recommendations.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty cache when file is absent", () => {
    const cache = readRecommendations(path);
    expect(cache.version).toBe(1);
    expect(cache.recommendations).toEqual({});
  });

  it("returns an empty cache for an empty file", () => {
    writeFileSync(path, "");
    const cache = readRecommendations(path);
    expect(cache.recommendations).toEqual({});
  });

  it("throws on malformed JSON", () => {
    writeFileSync(path, "{ not json");
    expect(() => readRecommendations(path)).toThrow(/not valid JSON/);
  });

  it("throws on schema mismatch", () => {
    writeFileSync(path, JSON.stringify({ version: 999, recommendations: {} }));
    expect(() => readRecommendations(path)).toThrow(/schema validation/);
  });

  it("rejects an action whose kind is not whitelisted", () => {
    const bogus = {
      version: 1,
      recommendations: {
        a: {
          ...makeRec("a"),
          action: { kind: "delete_repo", args: {} },
        },
      },
    };
    writeFileSync(path, JSON.stringify(bogus));
    expect(() => readRecommendations(path)).toThrow(/schema validation/);
  });
});

describe("putRecommendation / updateRecommendations", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkTmp();
    path = join(dir, "recommendations.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file on first write", async () => {
    expect(existsSync(path)).toBe(false);
    await putRecommendation(makeRec("a"), { recommendationsPath: path });
    expect(existsSync(path)).toBe(true);
    const cache = readRecommendations(path);
    expect(cache.recommendations.a?.summary).toBe("summary for a");
  });

  it("replaces an existing recommendation by id", async () => {
    await putRecommendation(makeRec("a", "v1"), { recommendationsPath: path });
    await putRecommendation(makeRec("a", "v2"), { recommendationsPath: path });
    const cache = readRecommendations(path);
    expect(cache.recommendations.a?.summary).toBe("v2");
  });

  it("aborts the write when mutator returns null", async () => {
    await putRecommendation(makeRec("a"), { recommendationsPath: path });
    const result = await updateRecommendations(() => null, {
      recommendationsPath: path,
    });
    expect(result).toBeNull();
    // File should still hold the original write.
    expect(readRecommendations(path).recommendations.a?.summary).toBe("summary for a");
  });

  it("serializes concurrent writers via the advisory lock", async () => {
    // Fire many writers in parallel; all must land without losing entries.
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
    await Promise.all(
      ids.map((id) => putRecommendation(makeRec(id), { recommendationsPath: path })),
    );
    const cache = readRecommendations(path);
    for (const id of ids) {
      expect(cache.recommendations[id]?.summary).toBe(`summary for ${id}`);
    }
  });
});

describe("evictStale", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkTmp();
    path = join(dir, "recommendations.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops entries whose ids are not in the live set", async () => {
    await putRecommendation(makeRec("a"), { recommendationsPath: path });
    await putRecommendation(makeRec("b"), { recommendationsPath: path });
    await putRecommendation(makeRec("c"), { recommendationsPath: path });

    const dropped = await evictStale(new Set(["b"]), {
      recommendationsPath: path,
    });
    expect(dropped).toBe(2);
    const cache = readRecommendations(path);
    expect(Object.keys(cache.recommendations)).toEqual(["b"]);
  });

  it("is a no-op when nothing is stale", async () => {
    await putRecommendation(makeRec("a"), { recommendationsPath: path });
    const dropped = await evictStale(new Set(["a"]), {
      recommendationsPath: path,
    });
    expect(dropped).toBe(0);
  });
});
