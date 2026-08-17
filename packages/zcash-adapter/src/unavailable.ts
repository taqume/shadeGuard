import {
  ProviderCapability,
  type PaymentStatus,
  type PaymentSubmission,
  type ProviderInfo,
  type ShieldedPaymentRequest,
  type ZcashProvider,
} from "./types.js";

/** A truthful fallback for the web console: it never returns fabricated wallet data. */
export class UnavailableZcashProvider implements ZcashProvider {
  private readonly providerInfo: ProviderInfo = {
    name: "wallet-disconnected",
    version: "unavailable",
    network: "testnet",
    capabilities: new Set<ProviderCapability>(),
  };

  public async initialize(): Promise<ProviderInfo> {
    return this.providerInfo;
  }

  public info(): ProviderInfo {
    return this.providerInfo;
  }

  public async canAfford(_amountZatoshi: number): Promise<boolean> {
    throw new Error("Wallet provider is unavailable");
  }

  public async sendShielded(_request: ShieldedPaymentRequest): Promise<PaymentSubmission> {
    throw new Error("Wallet provider is unavailable");
  }

  public async getPaymentStatus(_paymentId: string): Promise<PaymentStatus> {
    throw new Error("Wallet provider is unavailable");
  }

  public async getReceiveAddress(): Promise<string> {
    throw new Error("Wallet provider is unavailable");
  }
}
