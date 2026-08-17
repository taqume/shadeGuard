import { randomUUID } from "node:crypto";

import { classifyRecipient } from "@shadeguard/core";

import {
  ProviderCapability,
  type PaymentStatus,
  type PaymentSubmission,
  type ProviderInfo,
  type ShieldedPaymentRequest,
  type ZcashProvider,
} from "./types.js";

const MOCK_ADDRESS = `utest1${"q".repeat(90)}`;

export class MockZcashProvider implements ZcashProvider {
  public readonly calls: string[] = [];
  private readonly payments = new Map<string, PaymentStatus>();
  private providerInfo?: ProviderInfo;

  public constructor(private balanceZatoshi = 1_342_700_000) {}

  public async initialize(): Promise<ProviderInfo> {
    this.providerInfo = {
      name: "mock-zcash",
      version: "0.1.0",
      network: "testnet",
      capabilities: new Set(Object.values(ProviderCapability)),
    };
    return this.providerInfo;
  }

  public info(): ProviderInfo {
    if (!this.providerInfo) throw new Error("Provider is not initialized");
    return this.providerInfo;
  }

  public async canAfford(amountZatoshi: number): Promise<boolean> {
    this.calls.push(ProviderCapability.CAN_AFFORD);
    return amountZatoshi > 0 && this.balanceZatoshi >= amountZatoshi;
  }

  public async sendShielded(request: ShieldedPaymentRequest): Promise<PaymentSubmission> {
    this.calls.push(ProviderCapability.SEND_SHIELDED);
    const recipient = classifyRecipient(request.recipient);
    if (recipient.kind !== "shielded" || recipient.network !== "testnet") {
      throw new Error("Mock provider accepts only testnet shielded recipients");
    }
    if (request.amountZatoshi <= 0 || request.amountZatoshi > this.balanceZatoshi) {
      throw new Error("Insufficient mock funds");
    }

    this.balanceZatoshi -= request.amountZatoshi;
    const paymentId = `mock-${randomUUID()}`;
    this.payments.set(paymentId, { paymentId, status: "PENDING" });
    return { paymentId, status: "SUBMITTED" };
  }

  public async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    this.calls.push(ProviderCapability.GET_PAYMENT_STATUS);
    return this.payments.get(paymentId) ?? { paymentId, status: "UNKNOWN" };
  }

  public async getReceiveAddress(): Promise<string> {
    this.calls.push(ProviderCapability.GET_RECEIVE_ADDRESS);
    return MOCK_ADDRESS;
  }

  public confirm(paymentId: string): void {
    if (!this.payments.has(paymentId)) throw new Error("Mock payment was not found");
    this.payments.set(paymentId, { paymentId, status: "CONFIRMED", confirmations: 1, txId: paymentId });
  }
}
