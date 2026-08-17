import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { InMemoryApprovalService } from "@shadeguard/approval-service";
import { DeterministicPolicyEngine, MemoryAuditSink, parseZec } from "@shadeguard/core";
import { MockZcashProvider } from "@shadeguard/zcash-adapter";
import { describe, expect, it } from "vitest";

import { ShadeGuardGateway } from "./gateway.js";
import { createShadeGuardMcpServer } from "./mcp.js";

async function connectedPair() {
  const provider = new MockZcashProvider(1_342_700_000);
  const gateway = new ShadeGuardGateway(
    new DeterministicPolicyEngine({
      maxPerTxZatoshi: parseZec("0.10"),
      dailyLimitZatoshi: parseZec("0.50"),
      approvalAboveZatoshi: parseZec("0.05"),
      allowedRecipientHashes: new Set(),
    }),
    provider,
    new InMemoryApprovalService(),
    new MemoryAuditSink(),
  );
  await gateway.initialize();

  const server = createShadeGuardMcpServer(gateway);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport, { mode: "legacy" });
  return { client, server };
}

describe("ShadeGuard MCP surface", () => {
  it("exposes only reviewed safe tools and never an exact-balance tool", async () => {
    const { client, server } = await connectedPair();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "shadeguard_can_afford",
        "shadeguard_get_payment_status",
        "shadeguard_get_receive_address",
        "shadeguard_resume_approved_payment",
        "shadeguard_safe_send",
      ]);
      expect(tools.tools.map((tool) => tool.name).join(" ")).not.toMatch(/balance|history|viewing|key/iu);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns a boolean without leaking the provider's exact balance", async () => {
    const { client, server } = await connectedPair();
    try {
      const result = await client.callTool({
        name: "shadeguard_can_afford",
        arguments: { amountZec: "0.01", purpose: "test API" },
      });
      const serialized = JSON.stringify(result);
      expect(result.structuredContent).toMatchObject({ affordable: true });
      expect(serialized).not.toContain("1342700000");
      expect(serialized).not.toContain("13.427");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
