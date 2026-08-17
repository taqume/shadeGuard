import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const safeToolNames = [
  "shadeguard_can_afford",
  "shadeguard_get_payment_status",
  "shadeguard_get_receive_address",
  "shadeguard_resume_approved_payment",
  "shadeguard_safe_send",
];

function structured(result: { readonly structuredContent?: unknown }): Record<string, unknown> {
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error("ShadeGuard returned no structured tool result");
  }
  return result.structuredContent as Record<string, unknown>;
}

async function main(): Promise<void> {
  const client = new Client({ name: "shadeguard-demo-agent", version: "0.1.0" });
  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const serverPath = fileURLToPath(new URL("../../../packages/mcp-gateway/dist/server.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      SHADEGUARD_MODE: "mock",
      SHADEGUARD_NETWORK: "testnet",
      SHADEGUARD_AUDIT_PATH: `${projectRoot}.shadeguard/demo-audit.jsonl`,
    },
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(safeToolNames)) {
      throw new Error(`Unexpected MCP tool surface: ${toolNames.join(", ")}`);
    }
    console.log("Safe MCP tools:", toolNames.join(", "));

    const affordability = structured(
      await client.callTool({
        name: "shadeguard_can_afford",
        arguments: { amountZec: "0.01", purpose: "buy demo API access" },
      }),
    );
    console.log("Minimum-information response:", affordability);

    const recipient = `utest1${"q".repeat(90)}`;
    const rewrite = structured(
      await client.callTool({
        name: "shadeguard_safe_send",
        arguments: {
          amountZec: "0.01",
          recipient,
          purpose: "buy demo API access",
          memo: "receipt to alice@example.com",
        },
      }),
    );
    console.log("PII memo decision:", rewrite);

    const sent = structured(
      await client.callTool({
        name: "shadeguard_safe_send",
        arguments: {
          amountZec: "0.01",
          recipient,
          purpose: "buy demo API access",
          memo: "receipt to alice@example.com",
          acceptSafeRewrite: true,
        },
      }),
    );
    console.log("Accepted safe rewrite:", sent);

    const payment = sent.payment;
    if (!payment || typeof payment !== "object" || !("paymentId" in payment)) {
      throw new Error("Demo payment was not submitted");
    }
    const paymentId = String(payment.paymentId);
    const status = structured(
      await client.callTool({
        name: "shadeguard_get_payment_status",
        arguments: { paymentId },
      }),
    );
    console.log("Task-scoped payment status:", status);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown demo failure";
  console.error(`ShadeGuard demo failed: ${message}`);
  process.exitCode = 1;
});
