#!/usr/bin/env node
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { classifyRecipient, formatZec, parseZec } from "@shadeguard/core";

import { ZingoIncomingPaymentVerifier } from "./payment.js";

const TX_ID = /^[0-9a-f]{64}$/iu;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function main(): Promise<void> {
  const host = process.env.PAID_API_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.PAID_API_PORT ?? "4180");
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Paid API demo may bind only to a loopback address");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("PAID_API_PORT is invalid");

  const recipient = required("PAID_API_RECIPIENT");
  const recipientInfo = classifyRecipient(recipient);
  if (recipientInfo.network !== "testnet" || recipientInfo.kind !== "shielded") {
    throw new Error("PAID_API_RECIPIENT must be a shielded testnet address");
  }
  const amountZatoshi = parseZec(process.env.PAID_API_AMOUNT_ZEC?.trim() || "0.01");
  if (amountZatoshi <= 0) throw new Error("PAID_API_AMOUNT_ZEC must be positive");

  const verifier = new ZingoIncomingPaymentVerifier({
    binaryPath: process.env.ZINGO_CLI_PATH?.trim() || "zingo-cli",
    dataDir: resolve(required("PAID_API_ZINGO_DATA_DIR")),
    serverUrl: process.env.ZINGO_SERVER_URL?.trim() || "https://testnet.zec.rocks:443",
    timeoutMs: Number(process.env.ZINGO_COMMAND_TIMEOUT_MS ?? "180000"),
  });

  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
      if (request.method !== "GET") {
        json(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
        return;
      }
      if (pathname === "/health") {
        json(response, 200, { ok: true, network: "testnet", paymentVerification: "merchant-wallet" });
        return;
      }
      if (pathname !== "/premium") {
        json(response, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }

      const paymentId = request.headers["x-zcash-payment"];
      const txId = Array.isArray(paymentId) ? undefined : paymentId?.trim();
      const requirement = {
        scheme: "zcash-shielded-testnet",
        network: "testnet",
        asset: "TAZ",
        amountZec: formatZec(amountZatoshi),
        amountZatoshi,
        recipient,
        purpose: "ShadeGuard paid API demo access",
        memoPolicy: "omit",
        proofHeader: "x-zcash-payment",
      };
      if (!txId || !TX_ID.test(txId)) {
        json(response, 402, { ok: false, error: "PAYMENT_REQUIRED", payment: requirement });
        return;
      }

      const paid = await verifier.verify(txId, amountZatoshi);
      if (!paid) {
        json(response, 402, { ok: false, error: "PAYMENT_NOT_CONFIRMED", payment: requirement });
        return;
      }
      json(response, 200, {
        ok: true,
        data: {
          message: "ShadeGuard paid API access granted.",
          privacy: "The merchant verified one incoming payment; no wallet history was exposed to the agent.",
        },
        payment: { txId, status: "CONFIRMED" },
      });
    })().catch(() => json(response, 503, { ok: false, error: "PAYMENT_VERIFICATION_UNAVAILABLE" }));
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(port, host, () => console.log(`[shadeguard] Paid API: http://${host}:${port}/premium`));
}

main().catch((error: unknown) => {
  console.error(`[shadeguard] Paid API startup failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
