import { describe, expect, it, vi } from "vitest";
import { comparableBuild, createBuildChecker, isNewerBuild } from "./build-update";

const A = "3116bdd0a6404868df899b9aadc97fbbadff2e11";
const B = "4a7c9e1f00112233445566778899aabbccddeeff";

describe("build update detection", () => {
  it("only compares real build ids", () => {
    expect(comparableBuild(A)).toBe(true);
    expect(comparableBuild("dev")).toBe(false);
    expect(comparableBuild(undefined)).toBe(false);
    expect(isNewerBuild(A, B)).toBe(true);
    expect(isNewerBuild(A, A.toUpperCase())).toBe(false);
    expect(isNewerBuild("dev", B)).toBe(false);
    expect(isNewerBuild(A, "dev")).toBe(false);
    expect(isNewerBuild(A, null)).toBe(false);
  });

  it("throttles checks and remembers a found update", async () => {
    let t = 0;
    const fetchServerBuild = vi.fn(async () => A);
    const c = createBuildChecker({ mine: A, fetchServerBuild, now: () => t, minGapMs: 60_000 });
    expect(await c.check()).toBeNull();
    t = 30_000;
    expect(await c.check()).toBeNull();
    expect(fetchServerBuild).toHaveBeenCalledTimes(1);
    fetchServerBuild.mockResolvedValue(B);
    expect(await c.check(true)).toBe(B);
    t = 31_000;
    expect(await c.check()).toBe(B);
    expect(fetchServerBuild).toHaveBeenCalledTimes(2);
  });

  it("never fetches for an uncomparable own build and survives network errors", async () => {
    const fetchServerBuild = vi.fn(async () => B);
    expect(await createBuildChecker({ mine: "dev", fetchServerBuild, now: () => 0 }).check(true)).toBeNull();
    expect(fetchServerBuild).not.toHaveBeenCalled();
    const failing = createBuildChecker({ mine: A, fetchServerBuild: () => Promise.reject(new Error("offline")), now: () => 0 });
    expect(await failing.check(true)).toBeNull();
  });
});
