export const Capability = {
  CAN_AFFORD: "CAN_AFFORD",
  SEND_SHIELDED: "SEND_SHIELDED",
  GET_PAYMENT_STATUS: "GET_PAYMENT_STATUS",
  GET_RECEIVE_ADDRESS: "GET_RECEIVE_ADDRESS",
  READ_EXACT_BALANCE: "READ_EXACT_BALANCE",
  LIST_TRANSACTIONS: "LIST_TRANSACTIONS",
  EXPORT_VIEWING_KEY: "EXPORT_VIEWING_KEY",
  EXPORT_SPENDING_KEY: "EXPORT_SPENDING_KEY",
  UNKNOWN: "UNKNOWN",
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export const Decision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
  REQUIRE_APPROVAL: "REQUIRE_APPROVAL",
  REWRITE: "REWRITE",
} as const;

export type Decision = (typeof Decision)[keyof typeof Decision];

export const RiskLevel = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const ReasonCode = {
  SAFE_CAPABILITY: "SAFE_CAPABILITY",
  UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
  KEY_EXPORT_FORBIDDEN: "KEY_EXPORT_FORBIDDEN",
  FULL_HISTORY_FORBIDDEN: "FULL_HISTORY_FORBIDDEN",
  EXACT_BALANCE_REWRITTEN: "EXACT_BALANCE_REWRITTEN",
  EXACT_BALANCE_NOT_NEEDED: "EXACT_BALANCE_NOT_NEEDED",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  MISSING_PURPOSE: "MISSING_PURPOSE",
  MISSING_PAYMENT_ID: "MISSING_PAYMENT_ID",
  MISSING_RECIPIENT: "MISSING_RECIPIENT",
  MAINNET_FORBIDDEN: "MAINNET_FORBIDDEN",
  TRANSPARENT_RECIPIENT_FORBIDDEN: "TRANSPARENT_RECIPIENT_FORBIDDEN",
  UNKNOWN_RECIPIENT_FORBIDDEN: "UNKNOWN_RECIPIENT_FORBIDDEN",
  MEMO_PII_REMOVED: "MEMO_PII_REMOVED",
  PER_TX_LIMIT_EXCEEDED: "PER_TX_LIMIT_EXCEEDED",
  DAILY_LIMIT_EXCEEDED: "DAILY_LIMIT_EXCEEDED",
  RECIPIENT_APPROVAL_REQUIRED: "RECIPIENT_APPROVAL_REQUIRED",
  AMOUNT_APPROVAL_REQUIRED: "AMOUNT_APPROVAL_REQUIRED",
  PROVIDER_CAPABILITY_UNAVAILABLE: "PROVIDER_CAPABILITY_UNAVAILABLE",
  PROVIDER_EXECUTION_FAILED: "PROVIDER_EXECUTION_FAILED",
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export type ZcashNetwork = "testnet" | "mainnet" | "unknown";
export type AddressKind = "shielded" | "transparent" | "unknown";

export interface RequesterContext {
  readonly agentId: string;
  readonly sessionId: string;
}

export interface Recipient {
  readonly address: string;
  readonly kind: AddressKind;
  readonly network: ZcashNetwork;
}

export interface CanonicalRequest {
  readonly id: string;
  readonly capability: Capability;
  readonly requester: RequesterContext;
  readonly createdAt: string;
  readonly purpose?: string;
  readonly amountZatoshi?: number;
  readonly recipient?: Recipient;
  readonly memo?: string;
  readonly paymentId?: string;
}

export interface PolicyResult {
  readonly decision: Decision;
  readonly risk: RiskLevel;
  readonly reasonCode: ReasonCode;
  readonly explanation: string;
  readonly rewrittenRequest?: CanonicalRequest;
}

export interface PolicyConfig {
  readonly maxPerTxZatoshi: number;
  readonly dailyLimitZatoshi: number;
  readonly approvalAboveZatoshi: number;
  readonly allowedRecipientHashes: ReadonlySet<string>;
}

export interface PolicyState {
  readonly spentTodayZatoshi: number;
}
