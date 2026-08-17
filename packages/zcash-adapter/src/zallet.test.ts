import { describe, expect, it, vi } from "vitest";

import { ProviderCapability } from "./types.js";
import { ZalletJsonRpcProvider } from "./zallet.js";

const testnetAddress = `utest1${"q".repeat(90)}`;

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function methodFrom(init?: RequestInit): { method: string; params: unknown[] } {
  return JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
}

describe("ZalletJsonRpcProvider", () => {
  it("discovers only allowlisted capabilities and reduces balance to a boolean", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = methodFrom(init);
      if (call.method === "rpc.discover") {
        return rpcResponse({
          info: { version: "0.1.0-beta.2" },
          methods: [
            { name: "rpc.discover", params: [] },
            { name: "z_getaddressforaccount", params: [{ name: "account" }] },
            { name: "z_getbalanceforaccount", params: [{ name: "account" }] },
            { name: "z_exportviewingkey", params: [{ name: "zaddr" }] },
          ],
        });
      }
      if (call.method === "z_getaddressforaccount") {
        return rpcResponse({ address: testnetAddress, receiver_types: ["orchard", "sapling"] });
      }
      if (call.method === "z_getbalanceforaccount") {
        return rpcResponse({ pools: { orchard: { valueZat: 1_342_700_000 } } });
      }
      throw new Error(`Unexpected method ${call.method}`);
    });
    const provider = new ZalletJsonRpcProvider({
      rpcUrl: "http://127.0.0.1:28232",
      rpcUser: "user",
      rpcPassword: "password",
      accountId: "account-uuid",
      fetchImpl: fetchMock as typeof fetch,
    });

    const info = await provider.initialize();
    const response = await provider.canAfford(1_000_000);

    expect(info.capabilities).toEqual(
      new Set([ProviderCapability.CAN_AFFORD, ProviderCapability.GET_RECEIVE_ADDRESS]),
    );
    expect(info.capabilities).not.toContain("EXPORT_VIEWING_KEY");
    expect(response).toBe(true);
    expect(JSON.stringify(response)).not.toContain("1342700000");
  });

  it("uses the beta z_sendmany method only when FullPrivacy is discoverable", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = methodFrom(init);
      calls.push(call);
      if (call.method === "rpc.discover") {
        return rpcResponse({
          info: { version: "0.1.0-beta.2" },
          methods: [
            { name: "rpc.discover", params: [] },
            { name: "z_getaddressforaccount", params: [{ name: "account" }] },
            { name: "z_sendmany", params: [{ name: "fromaddress" }, { name: "privacy_policy" }] },
            { name: "z_getoperationstatus", params: [{ name: "operationid" }] },
          ],
        });
      }
      if (call.method === "z_getaddressforaccount") {
        return rpcResponse({ address: testnetAddress, receiver_types: ["orchard", "sapling"] });
      }
      if (call.method === "z_sendmany") return rpcResponse("opid-shadeguard");
      throw new Error(`Unexpected method ${call.method}`);
    });
    const provider = new ZalletJsonRpcProvider({
      rpcUrl: "http://localhost:28232",
      rpcUser: "user",
      rpcPassword: "password",
      accountId: "account-uuid",
      fetchImpl: fetchMock as typeof fetch,
    });
    await provider.initialize();

    const submitted = await provider.sendShielded({
      requestId: "request-1",
      amountZatoshi: 1_000_000,
      recipient: testnetAddress,
    });

    const sendCall = calls.find((call) => call.method === "z_sendmany");
    expect(submitted).toEqual({ paymentId: "opid-shadeguard", status: "PENDING" });
    expect(sendCall?.params.at(-1)).toBe("FullPrivacy");
    expect(sendCall?.params[0]).toBe(testnetAddress);
  });

  it("fails closed when a send method lacks an explicit privacy policy parameter", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = methodFrom(init);
      if (call.method === "rpc.discover") {
        return rpcResponse({
          info: { version: "drifted" },
          methods: [
            { name: "rpc.discover", params: [] },
            { name: "z_getaddressforaccount", params: [{ name: "account" }] },
            { name: "z_sendmany", params: [{ name: "fromaddress" }] },
          ],
        });
      }
      return rpcResponse({ address: testnetAddress, receiver_types: ["orchard"] });
    });
    const provider = new ZalletJsonRpcProvider({
      rpcUrl: "http://zallet:28232",
      rpcUser: "user",
      rpcPassword: "password",
      accountId: "account-uuid",
      fetchImpl: fetchMock as typeof fetch,
    });
    await provider.initialize();

    expect(provider.info().capabilities.has(ProviderCapability.SEND_SHIELDED)).toBe(false);
    await expect(
      provider.sendShielded({ requestId: "1", amountZatoshi: 1, recipient: testnetAddress }),
    ).rejects.toThrow("SEND_SHIELDED");
  });

  it("rejects mainnet wallets and remote plain HTTP RPC", async () => {
    expect(
      () =>
        new ZalletJsonRpcProvider({
          rpcUrl: "http://wallet.example.com:28232",
          rpcUser: "user",
          rpcPassword: "password",
          accountId: "account-uuid",
        }),
    ).toThrow("restricted");
  });
});
