export const ProviderCapability = {
  CAN_AFFORD: "CAN_AFFORD",
  SEND_SHIELDED: "SEND_SHIELDED",
  GET_PAYMENT_STATUS: "GET_PAYMENT_STATUS",
  GET_RECEIVE_ADDRESS: "GET_RECEIVE_ADDRESS",
} as const;

export type ProviderCapability = (typeof ProviderCapability)[keyof typeof ProviderCapability];

export interface ProviderInfo {
  readonly name: string;
  readonly version: string;
  readonly network: "testnet";
  readonly capabilities: ReadonlySet<ProviderCapability>;
}

export interface ShieldedPaymentRequest {
  readonly requestId: string;
  readonly amountZatoshi: number;
  readonly recipient: string;
  readonly memo?: string;
}

export interface PaymentSubmission {
  readonly paymentId: string;
  readonly status: "SUBMITTED" | "PENDING";
}

export interface PaymentStatus {
  readonly paymentId: string;
  readonly status: "PENDING" | "CONFIRMED" | "FAILED" | "UNKNOWN";
  readonly confirmations?: number;
  readonly txId?: string;
}

export interface ZcashProvider {
  initialize(): Promise<ProviderInfo>;
  close?(): Promise<void>;
  info(): ProviderInfo;
  canAfford(amountZatoshi: number): Promise<boolean>;
  sendShielded(request: ShieldedPaymentRequest): Promise<PaymentSubmission>;
  getPaymentStatus(paymentId: string): Promise<PaymentStatus>;
  getReceiveAddress(): Promise<string>;
}

export class UnsupportedProviderCapabilityError extends Error {
  public constructor(capability: ProviderCapability) {
    super(`Provider does not support required capability: ${capability}`);
    this.name = "UnsupportedProviderCapabilityError";
  }
}
