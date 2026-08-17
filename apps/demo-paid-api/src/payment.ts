import { resolve } from "node:path";

import { NodeZingoCommandRunner, type ZingoCommandRunner } from "@shadeguard/zcash-adapter";

const TX_ID = /^[0-9a-f]{64}$/iu;

export interface IncomingPayment {
  readonly txId: string;
  readonly status: "PENDING" | "CONFIRMED" | "FAILED";
  readonly valueZatoshi: number;
}

export interface PaymentVerifierOptions {
  readonly binaryPath: string;
  readonly dataDir: string;
  readonly serverUrl: string;
  readonly timeoutMs?: number;
  readonly runner?: ZingoCommandRunner;
}

export function parseIncomingPayment(output: string, txId: string): IncomingPayment | undefined {
  if (!TX_ID.test(txId)) return undefined;
  const records = output.split(/(?=^\{\s*$)/mu);
  const escaped = txId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const record = records.find((entry) => new RegExp(`^\\s*txid:\\s*${escaped}\\s*$`, "imu").test(entry));
  if (!record) return undefined;

  const kind = /^\s*kind:\s*([^\r\n]+)$/imu.exec(record)?.[1]?.trim().toLowerCase();
  const statusText = /^\s*status:\s*([^\r\n]+)$/imu.exec(record)?.[1]?.trim().toUpperCase();
  const valueText = /^\s*value:\s*(\d+)\s*$/imu.exec(record)?.[1];
  const valueZatoshi = valueText === undefined ? undefined : Number(valueText);
  if (kind !== "received" || valueZatoshi === undefined || !Number.isSafeInteger(valueZatoshi)) return undefined;

  const status = statusText?.includes("FAIL") || statusText?.includes("REJECT")
    ? "FAILED"
    : statusText?.includes("CONFIRM")
      ? "CONFIRMED"
      : "PENDING";
  return { txId, status, valueZatoshi };
}

export class ZingoIncomingPaymentVerifier {
  private readonly runner: ZingoCommandRunner;
  private readonly dataDir: string;
  private readonly timeoutMs: number;

  public constructor(private readonly options: PaymentVerifierOptions) {
    this.runner = options.runner ?? new NodeZingoCommandRunner();
    this.dataDir = resolve(options.dataDir);
    this.timeoutMs = options.timeoutMs ?? 180_000;
    const server = new URL(options.serverUrl);
    const local = server.hostname === "127.0.0.1" || server.hostname === "localhost" || server.hostname === "::1";
    if (server.username || server.password || (server.protocol !== "https:" && !(server.protocol === "http:" && local))) {
      throw new Error("Paid API Zingo server must use HTTPS or loopback HTTP without credentials");
    }
  }

  public async verify(txId: string, minimumZatoshi: number): Promise<boolean> {
    if (!TX_ID.test(txId) || !Number.isSafeInteger(minimumZatoshi) || minimumZatoshi <= 0) return false;
    const { stdout } = await this.runner.run(
      this.options.binaryPath,
      [
        "--chain",
        "testnet",
        "--data-dir",
        this.dataDir,
        "--server",
        this.options.serverUrl,
        "--waitsync",
        "transactions",
      ],
      this.timeoutMs,
    );
    const payment = parseIncomingPayment(stdout, txId);
    return payment?.status === "CONFIRMED" && payment.valueZatoshi >= minimumZatoshi;
  }
}
