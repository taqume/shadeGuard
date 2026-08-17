import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/server";
import { Capability, canonicalizeRequest, type RequesterContext } from "@shadeguard/core";
import { z } from "zod";

import type { GatewayResult, ShadeGuardGateway } from "./gateway.js";

const amountSchema = z.union([z.string(), z.number()]).describe("Decimal ZEC amount with at most 8 decimal places");

function toolResult(result: GatewayResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: result.decision === "DENY",
  };
}

export function createShadeGuardMcpServer(gateway: ShadeGuardGateway): McpServer {
  const requester: RequesterContext = { agentId: "mcp-agent", sessionId: randomUUID() };
  const server = new McpServer(
    { name: "shadeguard", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Use only task-scoped ShadeGuard tools. Exact balance, transaction history, and wallet key access are intentionally unavailable.",
    },
  );

  server.registerTool(
    "shadeguard_can_afford",
    {
      title: "Check affordability without revealing balance",
      description: "Returns only whether the wallet can afford a concrete amount. Never returns exact balance.",
      inputSchema: z.object({
        amountZec: amountSchema,
        purpose: z.string().trim().min(1).max(200).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ amountZec, purpose }) =>
      toolResult(
        await gateway.execute(
          canonicalizeRequest({
            capability: Capability.CAN_AFFORD,
            requester,
            amountZec,
            ...(purpose === undefined ? {} : { purpose }),
          }),
        ),
      ),
  );

  server.registerTool(
    "shadeguard_safe_send",
    {
      title: "Send testnet shielded ZEC under policy",
      description:
        "Requests a testnet shielded payment. PII memos are rewritten, limits are enforced, and approval may be required.",
      inputSchema: z.object({
        amountZec: amountSchema,
        recipient: z.string().trim().min(10).max(300),
        purpose: z.string().trim().min(1).max(200),
        memo: z.string().max(512).optional(),
        acceptSafeRewrite: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ amountZec, recipient, purpose, memo, acceptSafeRewrite }) =>
      toolResult(
        await gateway.execute(
          canonicalizeRequest({
            capability: Capability.SEND_SHIELDED,
            requester,
            amountZec,
            recipient,
            purpose,
            ...(memo === undefined ? {} : { memo }),
          }),
          { acceptSafeRewrite },
        ),
      ),
  );

  server.registerTool(
    "shadeguard_get_payment_status",
    {
      title: "Get one payment status",
      description: "Returns status for one known payment ID without exposing wallet history.",
      inputSchema: z.object({ paymentId: z.string().trim().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ paymentId }) =>
      toolResult(
        await gateway.execute(
          canonicalizeRequest({ capability: Capability.GET_PAYMENT_STATUS, requester, paymentId }),
        ),
      ),
  );

  server.registerTool(
    "shadeguard_get_receive_address",
    {
      title: "Get a purpose-bound testnet receive address",
      description: "Returns a testnet shielded receive address only for a stated task purpose.",
      inputSchema: z.object({ purpose: z.string().trim().min(1).max(200) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ purpose }) =>
      toolResult(
        await gateway.execute(
          canonicalizeRequest({ capability: Capability.GET_RECEIVE_ADDRESS, requester, purpose }),
        ),
      ),
  );

  server.registerTool(
    "shadeguard_resume_approved_payment",
    {
      title: "Resume one user-approved payment",
      description: "Consumes a local user's one-use approval for the exact request and requester session.",
      inputSchema: z.object({ requestId: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ requestId }) => toolResult(await gateway.resumeApproved(requestId, requester)),
  );

  return server;
}
