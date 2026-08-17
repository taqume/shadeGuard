#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function structured(result: { readonly structuredContent?: unknown }): Record<string, unknown> {
  return record(result.structuredContent, "ShadeGuard MCP result");
}

function paidApiUrl(): URL {
  const url = new URL(process.env.PAID_API_URL?.trim() || "http://127.0.0.1:4180/premium");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback) throw new Error("Paid API demo client accepts only loopback HTTP");
  return url;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return record(await response.json(), "Paid API response");
}

async function main(): Promise<void> {
  const resumePaymentId = process.env.PAID_API_PAYMENT_ID?.trim();
  if (!resumePaymentId && process.env.RUN_ZCASH_TESTNET_SEND !== "1") {
    throw new Error("Paid API client requires explicit RUN_ZCASH_TESTNET_SEND=1 opt-in");
  }
  const url = paidApiUrl();
  const first = await fetch(url);
  const challenge = await body(first);
  if (first.status !== 402 || challenge.error !== "PAYMENT_REQUIRED") {
    throw new Error("Paid API did not return the expected HTTP 402 challenge");
  }
  const payment = record(challenge.payment, "Payment requirement");
  const amountZec = payment.amountZec;
  const recipient = payment.recipient;
  const purpose = payment.purpose;
  if (typeof amountZec !== "string" || typeof recipient !== "string" || typeof purpose !== "string") {
    throw new Error("Paid API payment requirement is incomplete");
  }
  console.log("HTTP 402 payment requirement:", { amountZec, network: payment.network, memoPolicy: payment.memoPolicy });

  const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const serverPath = fileURLToPath(new URL("../../../packages/mcp-gateway/dist/server.js", import.meta.url));
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const client = new Client({ name: "shadeguard-paid-api-agent", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...inheritedEnv,
      SHADEGUARD_MODE: "zingo",
      SHADEGUARD_NETWORK: "testnet",
      SHADEGUARD_AUDIT_PATH: `${projectRoot}.shadeguard/paid-api-audit.jsonl`,
      SHADEGUARD_SPEND_LEDGER_PATH: `${projectRoot}.shadeguard/paid-api-spend-ledger.jsonl`,
      SHADEGUARD_APPROVAL_SOCKET: `${projectRoot}.shadeguard/paid-api-approval.sock`,
    },
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
    let txId = resumePaymentId;
    if (!txId) {
      const affordability = structured(await client.callTool({
        name: "shadeguard_can_afford",
        arguments: { amountZec, purpose },
      }));
      if (affordability.affordable !== true) throw new Error("ShadeGuard reported that the payment cannot be afforded");

      const sent = structured(await client.callTool({
        name: "shadeguard_safe_send",
        arguments: { amountZec, recipient, purpose },
      }));
      const submitted = record(sent.payment, "Submitted payment");
      const submittedPaymentId = submitted.paymentId;
      if (typeof submittedPaymentId !== "string") throw new Error("ShadeGuard returned no payment ID");
      txId = submittedPaymentId;
      console.log("ShadeGuard shielded payment:", { decision: sent.decision, txId, status: submitted.status });
    } else {
      console.log("Resuming paid API verification:", { txId });
    }

    let confirmed = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const statusResult = structured(await client.callTool({
        name: "shadeguard_get_payment_status",
        arguments: { paymentId: txId },
      }));
      const paymentStatus = record(statusResult.paymentStatus, "Payment status");
      if (paymentStatus.status === "CONFIRMED") {
        confirmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (!confirmed) throw new Error("Payment was not confirmed within the short demo window");

    const retry = await fetch(url, { headers: { "x-zcash-payment": txId } });
    const unlocked = await body(retry);
    if (!retry.ok || unlocked.ok !== true) throw new Error("Paid API did not unlock after confirmed payment");
    console.log("Paid API response:", unlocked);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[shadeguard] Paid API client failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
