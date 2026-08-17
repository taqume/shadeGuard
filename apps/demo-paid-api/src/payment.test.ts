import { describe, expect, it } from "vitest";

import { ZingoIncomingPaymentVerifier, parseIncomingPayment } from "./payment.js";

const txId = "a".repeat(64);
const otherTxId = "b".repeat(64);

const output = `{
  txid: ${otherTxId}
  status: confirmed
  kind: sent
  spend status: confirmed spent in ${txId}
  value: 9000000
}
{
  txid: ${txId}
  status: confirmed
  blockheight: 4280311
  kind: received
  value: 1000000
}`;

describe("paid API payment verification", () => {
  it("selects the exact incoming transaction without exposing the wallet history", () => {
    expect(parseIncomingPayment(output, txId)).toEqual({ txId, status: "CONFIRMED", valueZatoshi: 1_000_000 });
    expect(parseIncomingPayment(output, "c".repeat(64))).toBeUndefined();
  });

  it("requires a confirmed incoming payment meeting the minimum amount", async () => {
    const runner = { run: async () => ({ stdout: output, stderr: "" }) };
    const verifier = new ZingoIncomingPaymentVerifier({
      binaryPath: "/opt/zingo-cli",
      dataDir: "/tmp/shadeguard-paid-api-test",
      serverUrl: "https://testnet.zec.rocks:443",
      runner,
    });

    await expect(verifier.verify(txId, 1_000_000)).resolves.toBe(true);
    await expect(verifier.verify(txId, 1_000_001)).resolves.toBe(false);
  });
});
