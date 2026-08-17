import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { classifyRecipient } from "@shadeguard/core";
import { z } from "zod";

import {
  ProviderCapability,
  type PaymentStatus,
  type PaymentSubmission,
  type ProviderInfo,
  type ShieldedPaymentRequest,
  type ZcashProvider,
} from "./types.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TX_ID = /^[0-9a-f]{64}$/iu;

export interface ZingoCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ZingoCommandRunner {
  run(binary: string, args: readonly string[], timeoutMs: number): Promise<ZingoCommandResult>;
}

export class NodeZingoCommandRunner implements ZingoCommandRunner {
  public async run(binary: string, args: readonly string[], timeoutMs: number): Promise<ZingoCommandResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(binary, [...args], {
        env: { ...process.env, RUST_LOG: "error" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finishWithError = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(message));
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finishWithError("Zingo CLI output exceeded the safety limit");
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", () => finishWithError("Zingo CLI could not be started"));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error("Zingo CLI command failed"));
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      const timer = setTimeout(() => finishWithError("Zingo CLI command timed out"), timeoutMs);
      timer.unref();
    });
  }
}

export interface ZingoCliOptions {
  readonly binaryPath: string;
  readonly dataDir: string;
  readonly serverUrl: string;
  readonly waitForSync?: boolean;
  readonly commandTimeoutMs?: number;
  readonly feeReserveZatoshi?: number;
  readonly runner?: ZingoCommandRunner;
}

const spendableSchema = z.object({ spendable_balance: z.number().int().nonnegative() });
const sendSchema = z.object({ txids: z.array(z.string().regex(TX_ID)).min(1) });

export class ZingoCliProvider implements ZcashProvider {
  private readonly dataDir: string;
  private readonly commandTimeoutMs: number;
  private readonly feeReserveZatoshi: number;
  private readonly waitForSync: boolean;
  private readonly runner: ZingoCommandRunner;
  private providerInfo?: ProviderInfo;
  private commandQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: ZingoCliOptions) {
    if (!options.binaryPath.trim()) throw new Error("Zingo CLI path is required");
    this.dataDir = resolve(options.dataDir);
    this.commandTimeoutMs = options.commandTimeoutMs ?? 180_000;
    this.feeReserveZatoshi = options.feeReserveZatoshi ?? 100_000;
    this.waitForSync = options.waitForSync ?? true;
    this.runner = options.runner ?? new NodeZingoCommandRunner();
    this.validateServer(options.serverUrl);
    if (!Number.isSafeInteger(this.commandTimeoutMs) || this.commandTimeoutMs < 1_000) {
      throw new Error("Zingo command timeout is invalid");
    }
    if (!Number.isSafeInteger(this.feeReserveZatoshi) || this.feeReserveZatoshi < 0) {
      throw new Error("Zingo fee reserve is invalid");
    }
  }

  public async initialize(): Promise<ProviderInfo> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    const { stdout } = await this.runner.run(this.options.binaryPath, ["--version"], 10_000);
    const version = /(?:v|version\s*)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/iu.exec(stdout)?.[1];
    if (!version) throw new Error("Zingo CLI version could not be verified");
    this.providerInfo = {
      name: "zingo-cli",
      version,
      network: "testnet",
      capabilities: new Set<ProviderCapability>([
        ProviderCapability.CAN_AFFORD,
        ProviderCapability.SEND_SHIELDED,
        ProviderCapability.GET_PAYMENT_STATUS,
        ProviderCapability.GET_RECEIVE_ADDRESS,
      ]),
    };
    return this.providerInfo;
  }

  public info(): ProviderInfo {
    if (!this.providerInfo) throw new Error("Zingo provider is not initialized");
    return this.providerInfo;
  }

  public async canAfford(amountZatoshi: number): Promise<boolean> {
    this.requirePositiveZatoshi(amountZatoshi);
    return this.enqueue(async () => {
      const values = await this.runJson("spendable_balance");
      const response = this.findParsed(values, spendableSchema, "spendable balance");
      return response.spendable_balance >= amountZatoshi + this.feeReserveZatoshi;
    });
  }

  public async sendShielded(request: ShieldedPaymentRequest): Promise<PaymentSubmission> {
    this.requirePositiveZatoshi(request.amountZatoshi);
    const recipient = classifyRecipient(request.recipient);
    if (recipient.network !== "testnet" || recipient.kind !== "shielded") {
      throw new Error("Zingo adapter accepts only testnet shielded recipients");
    }
    return this.enqueue(async () => {
      const args = [recipient.address, String(request.amountZatoshi)];
      if (request.memo !== undefined && request.memo.length > 0) args.push(request.memo);
      const values = await this.runJson("quicksend", args);
      const response = this.findParsed(values, sendSchema, "transaction submission");
      const paymentId = response.txids[0];
      if (!paymentId) throw new Error("Zingo returned no transaction ID");
      return { paymentId, status: "SUBMITTED" };
    });
  }

  public async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    if (!TX_ID.test(paymentId)) throw new Error("Payment ID must be a Zcash transaction ID");
    return this.enqueue(async () => {
      const stdout = await this.runCommand("transactions");
      const values = extractJsonValues(stdout);
      const record = this.findTransactionRecord(values, paymentId.toLowerCase());
      if (record) {
        const statusText = this.stringProperty(record, ["status", "state"])?.toUpperCase();
        const confirmations = this.numberProperty(record, ["confirmations", "confirmation_count"]);
        const blockHeight = this.numberProperty(record, ["blockheight", "block_height", "height"]);
        if (statusText?.includes("FAIL") || statusText?.includes("REJECT")) {
          return { paymentId, status: "FAILED", txId: paymentId };
        }
        if (statusText?.includes("CONFIRM") || (statusText === undefined && ((confirmations ?? 0) > 0 || (blockHeight ?? 0) > 0))) {
          return {
            paymentId,
            status: "CONFIRMED",
            txId: paymentId,
            ...(confirmations === undefined ? {} : { confirmations }),
          };
        }
        return { paymentId, status: "PENDING", txId: paymentId };
      }
      return parseZingoTransactionText(stdout, paymentId) ?? { paymentId, status: "UNKNOWN" };
    });
  }

  public async getReceiveAddress(): Promise<string> {
    return this.enqueue(async () => {
      const values = await this.runJson("addresses");
      const addresses = this.collectStrings(values).filter(
        (value) => value.startsWith("utest1") || value.startsWith("ztestsapling"),
      );
      const address = addresses.find((value) => value.startsWith("utest1")) ?? addresses[0];
      if (!address) throw new Error("Zingo returned no testnet shielded receive address");
      return address;
    });
  }

  private async runJson(command: string, extraArgs: readonly string[] = []): Promise<unknown[]> {
    const stdout = await this.runCommand(command, extraArgs);
    const values = extractJsonValues(stdout);
    if (values.length === 0) throw new Error("Zingo CLI returned no structured response");
    return values;
  }

  private async runCommand(command: string, extraArgs: readonly string[] = []): Promise<string> {
    const args = [
      "--chain",
      "testnet",
      "--data-dir",
      this.dataDir,
      "--server",
      this.options.serverUrl,
      ...(this.waitForSync ? ["--waitsync"] : []),
      command,
      ...extraArgs,
    ];
    const { stdout } = await this.runner.run(this.options.binaryPath, args, this.commandTimeoutMs);
    return stdout;
  }

  private findParsed<T>(values: readonly unknown[], schema: z.ZodType<T>, label: string): T {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const parsed = schema.safeParse(values[index]);
      if (parsed.success) return parsed.data;
    }
    throw new Error(`Zingo ${label} response was invalid`);
  }

  private findTransactionRecord(values: readonly unknown[], paymentId: string): Record<string, unknown> | undefined {
    const visit = (value: unknown): Record<string, unknown> | undefined => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = visit(entry);
          if (found) return found;
        }
        return undefined;
      }
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      if (Object.values(record).some((entry) => typeof entry === "string" && entry.toLowerCase() === paymentId)) {
        return record;
      }
      for (const entry of Object.values(record)) {
        const found = visit(entry);
        if (found) return found;
      }
      return undefined;
    };
    for (const value of values) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  }

  private collectStrings(values: readonly unknown[]): string[] {
    const result: string[] = [];
    const visit = (value: unknown) => {
      if (typeof value === "string") result.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
    };
    values.forEach(visit);
    return result;
  }

  private stringProperty(record: Record<string, unknown>, names: readonly string[]): string | undefined {
    for (const name of names) if (typeof record[name] === "string") return record[name];
    return undefined;
  }

  private numberProperty(record: Record<string, unknown>, names: readonly string[]): number | undefined {
    for (const name of names) if (typeof record[name] === "number") return record[name];
    return undefined;
  }

  private requirePositiveZatoshi(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("A positive integer zatoshi amount is required");
  }

  private validateServer(raw: string): void {
    const server = new URL(raw);
    if (server.username || server.password) throw new Error("Zingo server URL must not contain credentials");
    const local = server.hostname === "127.0.0.1" || server.hostname === "localhost" || server.hostname === "::1";
    if (server.protocol !== "https:" && !(server.protocol === "http:" && local)) {
      throw new Error("Zingo server must use HTTPS or loopback HTTP");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.commandQueue.then(operation, operation);
    this.commandQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}

/** Parses only task-scoped status fields from current Zingo's human-readable transaction output. */
export function parseZingoTransactionText(output: string, paymentId: string): PaymentStatus | undefined {
  if (!TX_ID.test(paymentId)) return undefined;
  const records = output.split(/(?=^\{\s*$)/mu);
  const escaped = paymentId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const record = records.find((entry) => new RegExp(`^\\s*txid:\\s*${escaped}\\s*$`, "imu").test(entry));
  if (!record) return undefined;
  const status = /^\s*status:\s*([^\r\n]+)$/imu.exec(record)?.[1]?.trim().toUpperCase();
  const blockHeightText = /^\s*blockheight:\s*(\d+)\s*$/imu.exec(record)?.[1];
  const blockHeight = blockHeightText === undefined ? undefined : Number(blockHeightText);
  if (status?.includes("FAIL") || status?.includes("REJECT")) {
    return { paymentId, status: "FAILED", txId: paymentId };
  }
  if (status?.includes("CONFIRM") || (status === undefined && (blockHeight ?? 0) > 0)) {
    return { paymentId, status: "CONFIRMED", txId: paymentId };
  }
  return { paymentId, status: "PENDING", txId: paymentId };
}

/** Extracts JSON objects/arrays from Zingo's mixed informational stdout. */
export function extractJsonValues(output: string): unknown[] {
  const values: unknown[] = [];
  for (let start = 0; start < output.length; start += 1) {
    const first = output[start];
    if (first !== "{" && first !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const character = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) break;
        if (stack.length === 0) {
          try {
            values.push(JSON.parse(output.slice(start, index + 1)) as unknown);
            start = index;
          } catch {
            // Informational CLI output can contain non-JSON brackets; skip it.
          }
          break;
        }
      }
    }
  }
  return values;
}
