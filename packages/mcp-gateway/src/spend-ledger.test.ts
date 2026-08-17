import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonlSpendLedger } from "./spend-ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlSpendLedger", () => {
  it("survives process-style re-instantiation and keeps reservations idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shadeguard-ledger-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "spend.jsonl");
    const first = new JsonlSpendLedger(path);

    expect(await first.reserve("2026-08-17", "request-1", 1_000_000)).toBe(true);
    expect(await first.reserve("2026-08-17", "request-1", 1_000_000)).toBe(false);
    expect(await first.spentOn("2026-08-17")).toBe(1_000_000);

    const restarted = new JsonlSpendLedger(path);
    expect(await restarted.spentOn("2026-08-17")).toBe(1_000_000);
    await expect(restarted.reserve("2026-08-17", "request-1", 2_000_000)).rejects.toThrow("conflicts");
  });

  it("fails closed on a malformed ledger instead of resetting the budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shadeguard-ledger-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "spend.jsonl");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not-json\n", { mode: 0o600 });

    await expect(new JsonlSpendLedger(path).spentOn("2026-08-17")).rejects.toThrow();
  });
});
