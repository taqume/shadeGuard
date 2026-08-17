import { parseZec } from "@shadeguard/core";
import { describe, expect, it } from "vitest";

import { ProviderCapability } from "./types.js";
import { ZalletJsonRpcProvider } from "./zallet.js";

const runReadOnly = process.env.RUN_ZCASH_TESTNET === "1";
const runSend = runReadOnly && process.env.RUN_ZCASH_TESTNET_SEND === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the testnet integration test`);
  return value;
}

function provider(): ZalletJsonRpcProvider {
  return new ZalletJsonRpcProvider({
    rpcUrl: required("ZALLET_RPC_URL"),
    rpcCookiePath: required("ZALLET_RPC_COOKIE_PATH"),
    accountId: required("ZALLET_ACCOUNT_ID"),
    fundSource: process.env.ZALLET_FUND_SOURCE === "sapling" ? "sapling" : "orchard",
    timeoutMs: 60_000,
  });
}

describe.runIf(runReadOnly)("Zallet public testnet integration", () => {
  it("discovers the pinned wallet contract and returns only privacy-safe capabilities", async () => {
    const adapter = provider();
    const info = await adapter.initialize();
    const address = await adapter.getReceiveAddress();
    const affordable = await adapter.canAfford(1);

    expect(info.network).toBe("testnet");
    expect(info.capabilities).toContain(ProviderCapability.CAN_AFFORD);
    expect(info.capabilities).toContain(ProviderCapability.GET_RECEIVE_ADDRESS);
    expect(address).toMatch(/^(?:utest1|ztestsapling)/u);
    expect(typeof affordable).toBe("boolean");
  });

  it.runIf(runSend)("broadcasts an explicitly enabled shielded testnet transfer", async () => {
    const adapter = provider();
    const info = await adapter.initialize();
    expect(info.capabilities).toContain(ProviderCapability.SEND_SHIELDED);

    const submission = await adapter.sendShielded({
      requestId: `testnet-integration-${Date.now()}`,
      amountZatoshi: parseZec(required("ZCASH_TESTNET_SEND_ZEC")),
      recipient: required("ZCASH_TESTNET_RECIPIENT"),
    });

    expect(submission.paymentId.length).toBeGreaterThan(10);
    expect(["PENDING", "SUBMITTED"]).toContain(submission.status);
  });
});
