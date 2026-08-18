import { resolve } from "node:path";

import { InMemoryApprovalService } from "@shadeguard/approval-service";
import { DeterministicPolicyEngine, JsonlAuditSink, parseZec, stableHash } from "@shadeguard/core";
import {
  DownstreamMcpZcashProvider,
  MockZcashProvider,
  UnavailableZcashProvider,
  ZingoCliProvider,
  type ZcashProvider,
} from "@shadeguard/zcash-adapter";

import { ShadeGuardGateway } from "./gateway.js";
import { JsonlSpendLedger } from "./spend-ledger.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this mode`);
  return value;
}

export function createProvider(): ZcashProvider {
  const mode = process.env.SHADEGUARD_MODE ?? "disconnected";
  if ((process.env.SHADEGUARD_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("ShadeGuard MVP supports testnet only");
  }
  if (mode === "mock") return new MockZcashProvider();
  if (mode === "disconnected") return new UnavailableZcashProvider();
  if (mode === "zingo") {
    const timeout = Number(process.env.ZINGO_COMMAND_TIMEOUT_MS ?? "180000");
    const feeReserve = Number(process.env.ZINGO_FEE_RESERVE_ZATOSHI ?? "100000");
    return new ZingoCliProvider({
      binaryPath: process.env.ZINGO_CLI_PATH?.trim() || "zingo-cli",
      dataDir: resolve(process.env.ZINGO_DATA_DIR?.trim() || ".shadeguard/zingo-testnet"),
      serverUrl: process.env.ZINGO_SERVER_URL?.trim() || "https://testnet.zec.rocks:443",
      waitForSync: process.env.ZINGO_WAIT_FOR_SYNC !== "false",
      commandTimeoutMs: timeout,
      feeReserveZatoshi: feeReserve,
    });
  }
  if (mode === "mcp") {
    const rawArgs = process.env.ZCASH_MCP_ARGS_JSON ?? "[]";
    const parsedArgs = JSON.parse(rawArgs) as unknown;
    if (!Array.isArray(parsedArgs) || !parsedArgs.every((argument) => typeof argument === "string")) {
      throw new Error("ZCASH_MCP_ARGS_JSON must be a JSON array of strings");
    }
    return new DownstreamMcpZcashProvider({
      name: "downstream-zcash-mcp",
      command: requiredEnv("ZCASH_MCP_COMMAND"),
      args: parsedArgs,
      tools: {
        getReceiveAddress: requiredEnv("ZCASH_MCP_RECEIVE_TOOL"),
        ...(process.env.ZCASH_MCP_CAN_AFFORD_TOOL
          ? { canAfford: process.env.ZCASH_MCP_CAN_AFFORD_TOOL }
          : {}),
        ...(process.env.ZCASH_MCP_SEND_TOOL ? { sendShielded: process.env.ZCASH_MCP_SEND_TOOL } : {}),
        ...(process.env.ZCASH_MCP_STATUS_TOOL
          ? { getPaymentStatus: process.env.ZCASH_MCP_STATUS_TOOL }
          : {}),
        amountUnit: process.env.ZCASH_MCP_AMOUNT_UNIT === "zatoshi" ? "zatoshi" : "zec",
      },
    });
  }
  throw new Error(`Unsupported SHADEGUARD_MODE: ${mode}`);
}

export async function createRuntimeGateway(options: { readonly provider?: ZcashProvider } = {}): Promise<ShadeGuardGateway> {
  const allowedRecipientHashes = new Set(
    (process.env.SHADEGUARD_ALLOWED_RECIPIENTS ?? "")
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean)
      .map(stableHash),
  );
  const policy = new DeterministicPolicyEngine({
    maxPerTxZatoshi: parseZec(process.env.SHADEGUARD_MAX_PER_TX_ZEC ?? "0.10"),
    dailyLimitZatoshi: parseZec(process.env.SHADEGUARD_DAILY_LIMIT_ZEC ?? "0.50"),
    approvalAboveZatoshi: parseZec(process.env.SHADEGUARD_APPROVAL_ABOVE_ZEC ?? "0.05"),
    allowedRecipientHashes,
  });
  const audit = new JsonlAuditSink(resolve(process.env.SHADEGUARD_AUDIT_PATH ?? ".shadeguard/audit.jsonl"));
  const spendLedger = new JsonlSpendLedger(
    resolve(process.env.SHADEGUARD_SPEND_LEDGER_PATH ?? ".shadeguard/spend-ledger.jsonl"),
  );
  const gateway = new ShadeGuardGateway(
    policy,
    options.provider ?? createProvider(),
    new InMemoryApprovalService(),
    audit,
    spendLedger,
  );
  await gateway.initialize();
  return gateway;
}
