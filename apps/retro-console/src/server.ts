#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createIntentAnalyzerFromEnv, IntentAnalyzer } from "@shadeguard/ai-adapter";
import { Capability, canonicalizeRequest, type RequesterContext } from "@shadeguard/core";
import { createRuntimeGateway, type ShadeGuardGateway } from "@shadeguard/mcp-gateway";
import { UnavailableZcashProvider } from "@shadeguard/zcash-adapter";
import { z } from "zod";

const BODY_LIMIT = 16 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const instructionSchema = z.object({ instruction: z.string().trim().min(1).max(4_000) }).strict();
const amountSchema = z.union([z.string(), z.number()]);
const affordabilitySchema = z.object({ amountZec: amountSchema, purpose: z.string().trim().max(200).optional() }).strict();
const sendSchema = z.object({
  amountZec: amountSchema,
  recipient: z.string().trim().min(10).max(300),
  purpose: z.string().trim().min(1).max(200),
  memo: z.string().max(512).optional(),
  acceptSafeRewrite: z.boolean().optional(),
}).strict();
const paymentStatusSchema = z.object({ paymentId: z.string().trim().min(1).max(200) }).strict();
const receiveSchema = z.object({ purpose: z.string().trim().min(1).max(200) }).strict();

interface AppState {
  readonly gateway: ShadeGuardGateway;
  readonly requester: RequesterContext;
  readonly ai: ReturnType<typeof createIntentAnalyzerFromEnv>;
  readonly walletStartupError?: string;
  readonly auditPath: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly analysisTimes: number[];
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sameOrigin(request: IncomingMessage, state: AppState): boolean {
  const origin = request.headers.origin;
  return origin === undefined || state.allowedOrigins.has(origin);
}

function redactedAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  if (address.length <= 24) return "[REDACTED]";
  return `${address.slice(0, 12)}…${address.slice(-8)}`;
}

function protections(reasonCode: string): string[] {
  const common = ["LLM güvenlik kararı vermedi", "Wallet sırrı LLM bağlamına girmedi"];
  const byReason: Record<string, string> = {
    EXACT_BALANCE_REWRITTEN: "Tam bakiye yerine yalnız can_afford önerildi",
    EXACT_BALANCE_NOT_NEEDED: "Tam bakiye agent'tan gizlendi",
    FULL_HISTORY_FORBIDDEN: "Tüm işlem geçmişi engellendi",
    KEY_EXPORT_FORBIDDEN: "Kalıcı wallet yetkisi dışa aktarılmadı",
    MEMO_PII_REMOVED: "Memo içindeki kişisel veri kaldırıldı",
    UNKNOWN_CAPABILITY: "Bilinmeyen yetki fail-closed engellendi",
    TRANSPARENT_RECIPIENT_FORBIDDEN: "Transparent alıcı reddedildi",
    MAINNET_FORBIDDEN: "Mainnet işlemi reddedildi",
  };
  const specific = byReason[reasonCode];
  return specific ? [...common, specific] : [...common, "Yalnız görev kapsamlı capability değerlendirildi"];
}

async function auditEvents(path: string): Promise<unknown[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents
      .split("\n")
      .filter(Boolean)
      .slice(-30)
      .reverse()
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

function checkAnalysisRate(state: AppState): boolean {
  const now = Date.now();
  while (state.analysisTimes[0] !== undefined && state.analysisTimes[0] < now - 60_000) state.analysisTimes.shift();
  if (state.analysisTimes.length >= 12) return false;
  state.analysisTimes.push(now);
  return true;
}

async function api(request: IncomingMessage, response: ServerResponse, state: AppState, pathname: string): Promise<void> {
  if (request.method === "GET" && pathname === "/api/status") {
    const provider = state.gateway.providerInfo();
    json(response, 200, {
      network: provider.network,
      wallet: {
        connected: provider.capabilities.size > 0,
        provider: provider.name,
        version: provider.version,
        capabilities: [...provider.capabilities],
        ...(state.walletStartupError === undefined ? {} : { message: state.walletStartupError }),
      },
      ai: {
        provider: state.ai.provider,
        configured: state.ai.provider !== "deterministic",
        ...(state.ai.model === undefined ? {} : { model: state.ai.model }),
      },
      policy: { decisionAuthority: "deterministic", exactBalanceExposed: false, testnetOnly: true },
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/audit") {
    json(response, 200, { events: await auditEvents(state.auditPath) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/approvals") {
    json(response, 200, { approvals: state.gateway.listApprovals() });
    return;
  }

  if (request.method !== "POST") {
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!sameOrigin(request, state)) {
    json(response, 403, { error: "ORIGIN_FORBIDDEN" });
    return;
  }
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    json(response, 415, { error: "JSON_REQUIRED" });
    return;
  }

  if (pathname === "/api/agent/analyze") {
    if (!checkAnalysisRate(state)) {
      json(response, 429, { error: "RATE_LIMITED" });
      return;
    }
    const input = instructionSchema.parse(await body(request));
    let providerNotice: string | undefined;
    let intent;
    try {
      intent = await state.ai.analyzer.analyze({ instruction: input.instruction, requesterId: state.requester.agentId });
    } catch (error) {
      const quotaUnavailable = error instanceof Error && (error.message.includes("RESOURCE_EXHAUSTED") || error.message.includes("429"));
      const providerName = state.ai.provider === "nvidia" ? "NVIDIA NIM" : "Gemini";
      providerNotice = quotaUnavailable
        ? `${providerName} kotası kullanılamadığı için yerel deterministik intent parser kullanıldı.`
        : `${providerName} çağrısı tamamlanamadığı için yerel deterministik intent parser kullanıldı.`;
      intent = await new IntentAnalyzer().analyze({ instruction: input.instruction, requesterId: state.requester.agentId });
    }
    const canonical = canonicalizeRequest({
      capability: intent.capability,
      requester: state.requester,
      purpose: intent.purpose,
      ...(intent.amountZec === undefined ? {} : { amountZec: intent.amountZec }),
      ...(intent.recipient === undefined ? {} : { recipient: intent.recipient }),
      ...(intent.paymentId === undefined ? {} : { paymentId: intent.paymentId }),
      ...(intent.memo === undefined ? {} : { memo: intent.memo }),
    });
    const policy = await state.gateway.inspect(canonical);
    json(response, 200, {
      agent: {
        source: intent.source,
        capability: intent.capability,
        purpose: intent.purpose,
        explanation: intent.explanation,
        ...(intent.amountZec === undefined ? {} : { amountZec: intent.amountZec }),
        ...(intent.recipient === undefined ? {} : { recipient: redactedAddress(intent.recipient) }),
        ...(intent.paymentId === undefined ? {} : { paymentId: intent.paymentId }),
        ...(intent.memo === undefined ? {} : { memo: "[yerel olarak korundu]" }),
        ...(providerNotice === undefined ? {} : { providerNotice }),
      },
      policy,
      protections: protections(policy.reasonCode),
      execution: { performed: false, reason: "Doğal dil analizi hiçbir zaman otomatik wallet işlemi çalıştırmaz." },
    });
    return;
  }

  if (pathname === "/api/wallet/can-afford") {
    const input = affordabilitySchema.parse(await body(request));
    json(response, 200, await state.gateway.execute(canonicalizeRequest({
      capability: Capability.CAN_AFFORD,
      requester: state.requester,
      amountZec: input.amountZec,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    })));
    return;
  }

  if (pathname === "/api/wallet/send") {
    const input = sendSchema.parse(await body(request));
    json(response, 200, await state.gateway.execute(canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester: state.requester,
      amountZec: input.amountZec,
      recipient: input.recipient,
      purpose: input.purpose,
      ...(input.memo === undefined ? {} : { memo: input.memo }),
    }), { acceptSafeRewrite: input.acceptSafeRewrite ?? false }));
    return;
  }

  if (pathname === "/api/wallet/status") {
    const input = paymentStatusSchema.parse(await body(request));
    json(response, 200, await state.gateway.execute(canonicalizeRequest({
      capability: Capability.GET_PAYMENT_STATUS,
      requester: state.requester,
      paymentId: input.paymentId,
    })));
    return;
  }

  if (pathname === "/api/wallet/receive") {
    const input = receiveSchema.parse(await body(request));
    json(response, 200, await state.gateway.execute(canonicalizeRequest({
      capability: Capability.GET_RECEIVE_ADDRESS,
      requester: state.requester,
      purpose: input.purpose,
    })));
    return;
  }

  const approval = /^\/api\/approvals\/([0-9a-f-]{36})\/approve$/iu.exec(pathname)?.[1];
  if (approval) {
    const { requestId } = state.gateway.approve(approval);
    json(response, 200, await state.gateway.resumeApproved(requestId, state.requester));
    return;
  }

  json(response, 404, { error: "NOT_FOUND" });
}

async function staticFile(response: ServerResponse, pathname: string): Promise<void> {
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };
  const asset = assets[pathname];
  if (!asset) {
    json(response, 404, { error: "NOT_FOUND" });
    return;
  }
  const contents = await readFile(resolve(PUBLIC_DIR, asset.file));
  securityHeaders(response);
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.type);
  response.end(contents);
}

async function createState(port: number): Promise<AppState> {
  const ai = createIntentAnalyzerFromEnv();
  let gateway: ShadeGuardGateway;
  let walletStartupError: string | undefined;
  try {
    gateway = await createRuntimeGateway();
  } catch {
    walletStartupError = "Zingo CLI bulunamadı veya doğrulanamadı; wallet işlemleri devre dışı.";
    gateway = await createRuntimeGateway({ provider: new UnavailableZcashProvider() });
  }
  return {
    gateway,
    requester: { agentId: "retro-console", sessionId: randomUUID() },
    ai,
    ...(walletStartupError === undefined ? {} : { walletStartupError }),
    auditPath: resolve(process.env.SHADEGUARD_AUDIT_PATH ?? ".shadeguard/audit.jsonl"),
    allowedOrigins: new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    analysisTimes: [],
  };
}

async function main(): Promise<void> {
  const host = process.env.SHADEGUARD_WEB_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.SHADEGUARD_WEB_PORT ?? "4173");
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Retro console may bind only to a loopback address");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Invalid web port");
  const state = await createState(port);
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
      if (pathname.startsWith("/api/")) await api(request, response, state, pathname);
      else await staticFile(response, pathname);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        json(response, 400, { error: "INVALID_REQUEST" });
      } else if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
        json(response, 413, { error: "BODY_TOO_LARGE" });
      } else {
        json(response, 502, { error: "SAFE_OPERATION_FAILED" });
      }
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(port, host, () => console.log(`[shadeguard] Retro console: http://${host}:${port}`));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => void state.gateway.close());
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  console.error(`[shadeguard] Web startup failed: ${message}`);
  process.exitCode = 1;
});
