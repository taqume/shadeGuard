import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ZingoCliProvider, extractJsonValues, type ZingoCommandRunner } from "./zingo.js";

const recipient = `utest1${"q".repeat(120)}`;
const txId = "a".repeat(64);

class ScriptedRunner implements ZingoCommandRunner {
  public readonly calls: { binary: string; args: readonly string[]; timeoutMs: number }[] = [];

  public constructor(private readonly responses: string[]) {}

  public async run(binary: string, args: readonly string[], timeoutMs: number) {
    this.calls.push({ binary, args: [...args], timeoutMs });
    const stdout = this.responses.shift();
    if (stdout === undefined) throw new Error("No scripted response");
    return { stdout, stderr: "" };
  }
}

async function provider(runner: ScriptedRunner): Promise<ZingoCliProvider> {
  const instance = new ZingoCliProvider({
    binaryPath: "/opt/zingo-cli",
    dataDir: join(await mkdtemp(join(tmpdir(), "shadeguard-zingo-")), "wallet"),
    serverUrl: "https://testnet.zec.rocks:443",
    waitForSync: false,
    feeReserveZatoshi: 100_000,
    runner,
  });
  await instance.initialize();
  return instance;
}

describe("ZingoCliProvider", () => {
  it("extracts JSON from mixed CLI output", () => {
    expect(extractJsonValues('sync started\n{"saved":true}\n[{"nested":"[safe]"}]\nquit')).toEqual([
      { saved: true },
      [{ nested: "[safe]" }],
    ]);
  });

  it("reduces spendable balance to a boolean and never returns the exact value", async () => {
    const runner = new ScriptedRunner(["Zingo CLI 5.0.0", 'sync\n{"spendable_balance":5100000}\nsaved']);
    const zingo = await provider(runner);

    await expect(zingo.canAfford(5_000_000)).resolves.toBe(true);
    expect(runner.calls[1]?.args).toContain("spendable_balance");
  });

  it("uses an argument vector for a testnet shielded quicksend", async () => {
    const runner = new ScriptedRunner(["Zingo CLI 5.0.0", `sync\n{"txids":["${txId}"]}\nsaved`]);
    const zingo = await provider(runner);

    await expect(
      zingo.sendShielded({ requestId: "request", amountZatoshi: 1_000_000, recipient }),
    ).resolves.toEqual({ paymentId: txId, status: "SUBMITTED" });
    expect(runner.calls[1]?.args.slice(-3)).toEqual(["quicksend", recipient, "1000000"]);
  });

  it("refuses transparent recipients before invoking Zingo", async () => {
    const runner = new ScriptedRunner(["Zingo CLI 5.0.0"]);
    const zingo = await provider(runner);

    await expect(
      zingo.sendShielded({ requestId: "request", amountZatoshi: 1, recipient: `tm${"a".repeat(40)}` }),
    ).rejects.toThrow("only testnet shielded");
    expect(runner.calls).toHaveLength(1);
  });

  it("returns only one shielded receive address from nested wallet output", async () => {
    const runner = new ScriptedRunner([
      "Zingo CLI 5.0.0",
      `sync\n[{"address":"${recipient}","transparent":"tm${"x".repeat(30)}"}]\nsaved`,
    ]);
    const zingo = await provider(runner);

    await expect(zingo.getReceiveAddress()).resolves.toBe(recipient);
  });
});
