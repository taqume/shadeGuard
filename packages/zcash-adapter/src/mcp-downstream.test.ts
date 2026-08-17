import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { DownstreamMcpZcashProvider } from "./mcp-downstream.js";
import { ProviderCapability } from "./types.js";

const address = `utest1${"q".repeat(90)}`;

describe("DownstreamMcpZcashProvider", () => {
  it("maps only configured safe tools and ignores broader downstream authority", async () => {
    let exportCalled = false;
    const downstream = new McpServer({ name: "test-zcash-mcp", version: "1.2.3" });
    downstream.registerTool(
      "wallet_affordability",
      { inputSchema: z.object({ amountZec: z.string() }) },
      async () => ({
        content: [{ type: "text", text: "true" }],
        structuredContent: { affordable: true },
      }),
    );
    downstream.registerTool(
      "wallet_send_shielded",
      {
        inputSchema: z.object({ amountZec: z.string(), recipient: z.string(), memo: z.string().optional() }),
      },
      async () => ({
        content: [{ type: "text", text: "submitted" }],
        structuredContent: { paymentId: "opid-test", status: "PENDING" },
      }),
    );
    downstream.registerTool(
      "wallet_payment_status",
      { inputSchema: z.object({ paymentId: z.string() }) },
      async ({ paymentId }) => ({
        content: [{ type: "text", text: "pending" }],
        structuredContent: { paymentId, status: "PENDING" },
      }),
    );
    downstream.registerTool("wallet_receive_address", {}, async () => ({
      content: [{ type: "text", text: "testnet address" }],
      structuredContent: { address },
    }));
    downstream.registerTool("export_viewing_key", {}, async () => {
      exportCalled = true;
      return { content: [{ type: "text", text: "must never be called" }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await downstream.connect(serverTransport);
    const provider = new DownstreamMcpZcashProvider({
      name: "test-downstream",
      transport: clientTransport,
      protocolMode: "legacy",
      tools: {
        canAfford: "wallet_affordability",
        sendShielded: "wallet_send_shielded",
        getPaymentStatus: "wallet_payment_status",
        getReceiveAddress: "wallet_receive_address",
      },
    });

    try {
      const info = await provider.initialize();
      expect(info.capabilities).toEqual(new Set(Object.values(ProviderCapability)));
      expect(await provider.canAfford(1_000_000)).toBe(true);
      expect(
        await provider.sendShielded({ requestId: "request", amountZatoshi: 1_000_000, recipient: address }),
      ).toEqual({ paymentId: "opid-test", status: "PENDING" });
      expect(await provider.getPaymentStatus("opid-test")).toEqual({
        paymentId: "opid-test",
        status: "PENDING",
      });
      expect(await provider.getReceiveAddress()).toBe(address);
      expect(exportCalled).toBe(false);
    } finally {
      await provider.close();
      await downstream.close();
    }
  });
});
