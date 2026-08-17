import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { classifyRecipient, formatZec } from "@shadeguard/core";
import { z } from "zod";

import {
  ProviderCapability,
  UnsupportedProviderCapabilityError,
  type PaymentStatus,
  type PaymentSubmission,
  type ProviderInfo,
  type ShieldedPaymentRequest,
  type ZcashProvider,
} from "./types.js";

const MAX_RPC_RESPONSE_BYTES = 1_000_000;

const OpenRpcSchema = z.object({
  info: z.object({ version: z.string() }),
  methods: z.array(
    z.object({
      name: z.string(),
      params: z.array(z.object({ name: z.string() })).default([]),
    }),
  ),
});

const BalanceSchema = z.object({
  pools: z.record(
    z.string(),
    z.object({
      valueZat: z.number().int().nonnegative().safe(),
    }),
  ),
});

const AddressSchema = z.object({
  address: z.string(),
  receiver_types: z.array(z.string()),
});

const OperationSchema = z.array(
  z.object({
    id: z.string().optional(),
    status: z.string(),
    result: z.object({ txid: z.string().optional() }).optional(),
    error: z.unknown().optional(),
  }),
);

export interface ZalletProviderConfig {
  readonly rpcUrl: string;
  readonly rpcUser?: string;
  readonly rpcPassword?: string;
  readonly rpcCookiePath?: string;
  readonly accountId: string;
  readonly fundSource?: "orchard" | "sapling";
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string } | null;
  readonly id?: number;
}

export class ZalletJsonRpcProvider implements ZcashProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly methodParams = new Map<string, ReadonlySet<string>>();
  private providerInfo?: ProviderInfo;
  private sourceAddress?: string;

  public constructor(private readonly config: ZalletProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.validateRpcUrl(config.rpcUrl);
    if (!config.accountId.trim()) throw new Error("Zallet accountId is required");
    if (!config.rpcCookiePath && (!config.rpcUser || !config.rpcPassword)) {
      throw new Error("Zallet RPC requires a cookie path or username/password credentials");
    }
  }

  public async initialize(): Promise<ProviderInfo> {
    const openRpc = OpenRpcSchema.parse(await this.call("rpc.discover", []));
    this.methodParams.clear();
    for (const method of openRpc.methods) {
      this.methodParams.set(method.name, new Set(method.params.map((parameter) => parameter.name)));
    }

    const capabilities = new Set<ProviderCapability>();
    if (this.hasMethod("z_getbalanceforaccount")) capabilities.add(ProviderCapability.CAN_AFFORD);
    if (this.hasPrivateSendMethod()) capabilities.add(ProviderCapability.SEND_SHIELDED);
    if (this.hasMethod("z_getoperationstatus") || this.hasMethod("getrawtransaction")) {
      capabilities.add(ProviderCapability.GET_PAYMENT_STATUS);
    }
    if (this.hasMethod("z_getaddressforaccount")) capabilities.add(ProviderCapability.GET_RECEIVE_ADDRESS);

    if (!capabilities.has(ProviderCapability.GET_RECEIVE_ADDRESS)) {
      throw new UnsupportedProviderCapabilityError(ProviderCapability.GET_RECEIVE_ADDRESS);
    }

    const sourceAddress = await this.fetchShieldedAddress();
    const source = classifyRecipient(sourceAddress);
    if (source.kind !== "shielded" || source.network !== "testnet") {
      throw new Error("Zallet is not configured for a verified testnet shielded account");
    }
    this.sourceAddress = sourceAddress;

    this.providerInfo = {
      name: "zallet-json-rpc",
      version: openRpc.info.version,
      network: "testnet",
      capabilities,
    };
    return this.providerInfo;
  }

  public info(): ProviderInfo {
    if (!this.providerInfo) throw new Error("Provider is not initialized");
    return this.providerInfo;
  }

  public async canAfford(amountZatoshi: number): Promise<boolean> {
    this.requireCapability(ProviderCapability.CAN_AFFORD);
    if (!Number.isSafeInteger(amountZatoshi) || amountZatoshi <= 0) return false;

    const balance = BalanceSchema.parse(await this.call("z_getbalanceforaccount", [this.config.accountId, 1]));
    return Object.entries(balance.pools)
      .filter(([pool]) => pool !== "transparent")
      .some(([, value]) => value.valueZat >= amountZatoshi);
  }

  public async sendShielded(request: ShieldedPaymentRequest): Promise<PaymentSubmission> {
    this.requireCapability(ProviderCapability.SEND_SHIELDED);
    const recipient = classifyRecipient(request.recipient);
    if (recipient.kind !== "shielded" || recipient.network !== "testnet") {
      throw new Error("Zallet adapter accepts only verified testnet shielded recipients");
    }
    if (!Number.isSafeInteger(request.amountZatoshi) || request.amountZatoshi <= 0) {
      throw new Error("Payment amount must be a positive zatoshi integer");
    }

    const payment = {
      address: recipient.address,
      amount: Number(formatZec(request.amountZatoshi)),
      ...(request.memo === undefined ? {} : { memo: this.encodeMemo(request.memo) }),
    };

    if (this.hasMethod("z_sendfromaccount")) {
      const txId = z.string().parse(
        await this.call("z_sendfromaccount", [
          this.config.accountId,
          this.config.fundSource ?? "orchard",
          [payment],
          1,
          "FullPrivacy",
        ]),
      );
      return { paymentId: txId, status: "SUBMITTED" };
    }

    const sourceAddress = this.sourceAddress;
    if (!sourceAddress) throw new Error("Zallet provider is not initialized");
    const operationId = z.string().parse(
      await this.call("z_sendmany", [sourceAddress, [payment], 1, null, "FullPrivacy"]),
    );
    return { paymentId: operationId, status: "PENDING" };
  }

  public async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    this.requireCapability(ProviderCapability.GET_PAYMENT_STATUS);

    if (paymentId.startsWith("opid-") && this.hasMethod("z_getoperationstatus")) {
      const operations = OperationSchema.parse(await this.call("z_getoperationstatus", [[paymentId]]));
      const operation = operations.find((item) => item.id === undefined || item.id === paymentId);
      if (!operation) return { paymentId, status: "UNKNOWN" };
      if (operation.status === "failed" || operation.error !== undefined) return { paymentId, status: "FAILED" };
      if (operation.status === "success") {
        return {
          paymentId,
          status: "CONFIRMED",
          confirmations: 0,
          ...(operation.result?.txid === undefined ? {} : { txId: operation.result.txid }),
        };
      }
      return { paymentId, status: "PENDING" };
    }

    if (!this.hasMethod("getrawtransaction")) return { paymentId, status: "UNKNOWN" };
    try {
      const raw = z.object({ confirmations: z.number().int().optional() }).parse(
        await this.call("getrawtransaction", [paymentId, 1]),
      );
      const confirmations = raw.confirmations ?? 0;
      return {
        paymentId,
        status: confirmations > 0 ? "CONFIRMED" : "PENDING",
        confirmations,
        txId: paymentId,
      };
    } catch {
      return { paymentId, status: "UNKNOWN" };
    }
  }

  public async getReceiveAddress(): Promise<string> {
    this.requireCapability(ProviderCapability.GET_RECEIVE_ADDRESS);
    if (!this.sourceAddress) this.sourceAddress = await this.fetchShieldedAddress();
    return this.sourceAddress;
  }

  private async fetchShieldedAddress(): Promise<string> {
    const response = AddressSchema.parse(
      await this.call("z_getaddressforaccount", [this.config.accountId, ["orchard", "sapling"]]),
    );
    if (response.receiver_types.includes("p2pkh")) {
      throw new Error("Zallet returned a transparent receiver despite a shielded-only request");
    }
    return response.address;
  }

  private hasPrivateSendMethod(): boolean {
    const sendFromAccount = this.methodParams.get("z_sendfromaccount");
    if (sendFromAccount?.has("privacy_policy")) return true;
    const sendMany = this.methodParams.get("z_sendmany");
    return sendMany?.has("privacy_policy") === true;
  }

  private hasMethod(name: string): boolean {
    return this.methodParams.has(name);
  }

  private requireCapability(capability: ProviderCapability): void {
    if (!this.info().capabilities.has(capability)) throw new UnsupportedProviderCapabilityError(capability);
  }

  private encodeMemo(memo: string): string {
    const bytes = Buffer.from(memo, "utf8");
    if (bytes.length > 512) throw new Error("Zcash memo exceeds 512 bytes");
    return bytes.toString("hex");
  }

  private async call(method: string, params: readonly unknown[]): Promise<unknown> {
    const auth = Buffer.from(await this.rpcCredential(), "utf8").toString("base64");
    const response = await this.fetchImpl(this.config.rpcUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RPC_RESPONSE_BYTES) throw new Error(`Zallet RPC response too large for ${method}`);
    const text = await response.text();
    if (text.length > MAX_RPC_RESPONSE_BYTES) throw new Error(`Zallet RPC response too large for ${method}`);
    if (!response.ok) throw new Error(`Zallet RPC HTTP failure for ${method}: ${response.status}`);

    let payload: JsonRpcResponse;
    try {
      payload = JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error(`Zallet RPC returned invalid JSON for ${method}`);
    }
    if (payload.error) {
      throw new Error(`Zallet RPC ${method} failed with code ${payload.error.code ?? "unknown"}`);
    }
    if (!("result" in payload)) throw new Error(`Zallet RPC ${method} returned no result`);
    return payload.result;
  }

  private async rpcCredential(): Promise<string> {
    if (this.config.rpcCookiePath) {
      const cookie = (await readFile(this.config.rpcCookiePath, "utf8")).trim();
      if (!cookie.startsWith("__cookie__:") || cookie.length <= "__cookie__:".length) {
        throw new Error("Zallet RPC cookie is invalid");
      }
      return cookie;
    }
    return `${this.config.rpcUser}:${this.config.rpcPassword}`;
  }

  private validateRpcUrl(value: string): void {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Zallet RPC URL must use HTTP or HTTPS");
    }
    const localHosts = new Set(["127.0.0.1", "localhost", "::1", "zallet"]);
    if (url.protocol === "http:" && !localHosts.has(url.hostname)) {
      throw new Error("Plain HTTP Zallet RPC is restricted to local/container hosts");
    }
  }
}
