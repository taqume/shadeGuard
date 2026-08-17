import { Client, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

const AffordabilitySchema = z.object({ affordable: z.boolean() });
const SubmissionSchema = z.object({
  paymentId: z.string().min(1),
  status: z.enum(["SUBMITTED", "PENDING"]),
});
const StatusSchema = z.object({
  paymentId: z.string().min(1),
  status: z.enum(["PENDING", "CONFIRMED", "FAILED", "UNKNOWN"]),
  confirmations: z.number().int().nonnegative().optional(),
  txId: z.string().min(1).optional(),
});
const AddressSchema = z.object({ address: z.string().min(1) });

export interface DownstreamMcpToolMapping {
  readonly canAfford?: string;
  readonly sendShielded?: string;
  readonly getPaymentStatus?: string;
  readonly getReceiveAddress: string;
  readonly amountUnit?: "zec" | "zatoshi";
}

export interface DownstreamMcpProviderConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly transport?: Transport;
  readonly protocolMode?: "auto" | "legacy";
  readonly tools: DownstreamMcpToolMapping;
}

export class DownstreamMcpZcashProvider implements ZcashProvider {
  private readonly client: Client;
  private providerInfo?: ProviderInfo;
  private receiveAddress?: string;

  public constructor(private readonly config: DownstreamMcpProviderConfig) {
    if (!config.transport && !config.command) throw new Error("Downstream MCP command or transport is required");
    this.client = new Client(
      { name: "shadeguard-downstream-client", version: "0.1.0" },
      { versionNegotiation: { mode: config.protocolMode ?? "auto" } },
    );
  }

  public async initialize(): Promise<ProviderInfo> {
    const transport =
      this.config.transport ??
      new StdioClientTransport({
        command: this.config.command as string,
        ...(this.config.args === undefined ? {} : { args: [...this.config.args] }),
        ...(this.config.cwd === undefined ? {} : { cwd: this.config.cwd }),
        stderr: "ignore",
      });
    await this.client.connect(transport);

    const listed = await this.client.listTools();
    const available = new Set(listed.tools.map((tool) => tool.name));
    const capabilities = new Set<ProviderCapability>();
    if (this.config.tools.canAfford && available.has(this.config.tools.canAfford)) {
      capabilities.add(ProviderCapability.CAN_AFFORD);
    }
    if (this.config.tools.sendShielded && available.has(this.config.tools.sendShielded)) {
      capabilities.add(ProviderCapability.SEND_SHIELDED);
    }
    if (this.config.tools.getPaymentStatus && available.has(this.config.tools.getPaymentStatus)) {
      capabilities.add(ProviderCapability.GET_PAYMENT_STATUS);
    }
    if (available.has(this.config.tools.getReceiveAddress)) {
      capabilities.add(ProviderCapability.GET_RECEIVE_ADDRESS);
    }

    if (!capabilities.has(ProviderCapability.GET_RECEIVE_ADDRESS)) {
      await this.client.close();
      throw new UnsupportedProviderCapabilityError(ProviderCapability.GET_RECEIVE_ADDRESS);
    }

    const receive = AddressSchema.parse(
      await this.callStructured(this.config.tools.getReceiveAddress, {}),
    ).address;
    const classified = classifyRecipient(receive);
    if (classified.kind !== "shielded" || classified.network !== "testnet") {
      await this.client.close();
      throw new Error("Downstream MCP did not prove a testnet shielded wallet boundary");
    }
    this.receiveAddress = receive;

    this.providerInfo = {
      name: this.config.name,
      version: this.client.getServerVersion()?.version ?? "unknown",
      network: "testnet",
      capabilities,
    };
    return this.providerInfo;
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  public info(): ProviderInfo {
    if (!this.providerInfo) throw new Error("Provider is not initialized");
    return this.providerInfo;
  }

  public async canAfford(amountZatoshi: number): Promise<boolean> {
    const tool = this.requireMapped(ProviderCapability.CAN_AFFORD, this.config.tools.canAfford);
    const result = AffordabilitySchema.parse(
      await this.callStructured(tool, this.amountArgument(amountZatoshi)),
    );
    return result.affordable;
  }

  public async sendShielded(request: ShieldedPaymentRequest): Promise<PaymentSubmission> {
    const tool = this.requireMapped(ProviderCapability.SEND_SHIELDED, this.config.tools.sendShielded);
    const recipient = classifyRecipient(request.recipient);
    if (recipient.kind !== "shielded" || recipient.network !== "testnet") {
      throw new Error("Downstream MCP adapter accepts only verified testnet shielded recipients");
    }
    return SubmissionSchema.parse(
      await this.callStructured(tool, {
        ...this.amountArgument(request.amountZatoshi),
        recipient: recipient.address,
        ...(request.memo === undefined ? {} : { memo: request.memo }),
      }),
    );
  }

  public async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    const tool = this.requireMapped(
      ProviderCapability.GET_PAYMENT_STATUS,
      this.config.tools.getPaymentStatus,
    );
    const status = StatusSchema.parse(await this.callStructured(tool, { paymentId }));
    return {
      paymentId: status.paymentId,
      status: status.status,
      ...(status.confirmations === undefined ? {} : { confirmations: status.confirmations }),
      ...(status.txId === undefined ? {} : { txId: status.txId }),
    };
  }

  public async getReceiveAddress(): Promise<string> {
    this.requireMapped(ProviderCapability.GET_RECEIVE_ADDRESS, this.config.tools.getReceiveAddress);
    if (!this.receiveAddress) throw new Error("Provider is not initialized");
    return this.receiveAddress;
  }

  private requireMapped(capability: ProviderCapability, tool: string | undefined): string {
    if (!tool || !this.info().capabilities.has(capability)) throw new UnsupportedProviderCapabilityError(capability);
    return tool;
  }

  private amountArgument(amountZatoshi: number): Readonly<Record<string, string | number>> {
    if (!Number.isSafeInteger(amountZatoshi) || amountZatoshi <= 0) {
      throw new Error("Amount must be a positive zatoshi integer");
    }
    return this.config.tools.amountUnit === "zatoshi"
      ? { amountZatoshi }
      : { amountZec: formatZec(amountZatoshi) };
  }

  private async callStructured(toolName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    if (result.isError) throw new Error(`Downstream MCP safe tool failed: ${toolName}`);
    if (result.structuredContent === undefined) {
      throw new Error(`Downstream MCP safe tool returned no structured content: ${toolName}`);
    }
    return result.structuredContent;
  }
}
