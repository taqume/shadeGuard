import { detectSensitiveMemo, stableHash } from "./privacy.js";
import {
  Capability,
  Decision,
  ReasonCode,
  RiskLevel,
  type CanonicalRequest,
  type PolicyConfig,
  type PolicyResult,
  type PolicyState,
} from "./types.js";

function result(
  decision: PolicyResult["decision"],
  risk: PolicyResult["risk"],
  reasonCode: PolicyResult["reasonCode"],
  explanation: string,
  rewrittenRequest?: CanonicalRequest,
): PolicyResult {
  return {
    decision,
    risk,
    reasonCode,
    explanation,
    ...(rewrittenRequest === undefined ? {} : { rewrittenRequest }),
  };
}

export class DeterministicPolicyEngine {
  public constructor(private readonly config: PolicyConfig) {}

  public evaluate(request: CanonicalRequest, state: PolicyState): PolicyResult {
    switch (request.capability) {
      case Capability.EXPORT_VIEWING_KEY:
      case Capability.EXPORT_SPENDING_KEY:
        return result(
          Decision.DENY,
          RiskLevel.CRITICAL,
          ReasonCode.KEY_EXPORT_FORBIDDEN,
          "Persistent wallet authority cannot be exported through ShadeGuard.",
        );

      case Capability.UNKNOWN:
        return result(
          Decision.DENY,
          RiskLevel.CRITICAL,
          ReasonCode.UNKNOWN_CAPABILITY,
          "Unknown capabilities fail closed and are never forwarded downstream.",
        );

      case Capability.LIST_TRANSACTIONS:
        return result(
          Decision.DENY,
          RiskLevel.HIGH,
          ReasonCode.FULL_HISTORY_FORBIDDEN,
          "Full transaction history is broader than a task-scoped payment status.",
        );

      case Capability.READ_EXACT_BALANCE:
        return this.evaluateExactBalance(request);

      case Capability.CAN_AFFORD:
        return this.evaluateCanAfford(request);

      case Capability.GET_PAYMENT_STATUS:
        return request.paymentId
          ? result(Decision.ALLOW, RiskLevel.LOW, ReasonCode.SAFE_CAPABILITY, "A single payment status is task-scoped.")
          : result(Decision.DENY, RiskLevel.LOW, ReasonCode.MISSING_PAYMENT_ID, "A payment ID is required.");

      case Capability.GET_RECEIVE_ADDRESS:
        return request.purpose
          ? result(Decision.ALLOW, RiskLevel.MEDIUM, ReasonCode.SAFE_CAPABILITY, "A purpose-bound receive address may be returned.")
          : result(Decision.DENY, RiskLevel.MEDIUM, ReasonCode.MISSING_PURPOSE, "A purpose is required before revealing a receive address.");

      case Capability.SEND_SHIELDED:
        return this.evaluateSend(request, state);
    }
  }

  private evaluateExactBalance(request: CanonicalRequest): PolicyResult {
    if (request.amountZatoshi === undefined || request.amountZatoshi <= 0) {
      return result(
        Decision.DENY,
        RiskLevel.MEDIUM,
        ReasonCode.EXACT_BALANCE_NOT_NEEDED,
        "Exact balance is not available; ask whether a concrete amount can be afforded.",
      );
    }

    const rewrittenRequest: CanonicalRequest = {
      id: request.id,
      capability: Capability.CAN_AFFORD,
      requester: request.requester,
      createdAt: request.createdAt,
      amountZatoshi: request.amountZatoshi,
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    };
    return result(
      Decision.REWRITE,
      RiskLevel.MEDIUM,
      ReasonCode.EXACT_BALANCE_REWRITTEN,
      "Exact balance was replaced with a minimum-information affordability check.",
      rewrittenRequest,
    );
  }

  private evaluateCanAfford(request: CanonicalRequest): PolicyResult {
    if (request.amountZatoshi === undefined || request.amountZatoshi <= 0) {
      return result(Decision.DENY, RiskLevel.LOW, ReasonCode.INVALID_AMOUNT, "A positive amount is required.");
    }
    return result(Decision.ALLOW, RiskLevel.LOW, ReasonCode.SAFE_CAPABILITY, "Only an affordability boolean will be returned.");
  }

  private evaluateSend(request: CanonicalRequest, state: PolicyState): PolicyResult {
    if (request.amountZatoshi === undefined || request.amountZatoshi <= 0) {
      return result(Decision.DENY, RiskLevel.HIGH, ReasonCode.INVALID_AMOUNT, "A positive send amount is required.");
    }
    if (!request.purpose) {
      return result(Decision.DENY, RiskLevel.HIGH, ReasonCode.MISSING_PURPOSE, "A task purpose is required for every payment.");
    }
    if (!request.recipient) {
      return result(Decision.DENY, RiskLevel.HIGH, ReasonCode.MISSING_RECIPIENT, "A recipient is required.");
    }
    if (request.recipient.network === "mainnet") {
      return result(Decision.DENY, RiskLevel.CRITICAL, ReasonCode.MAINNET_FORBIDDEN, "Mainnet is disabled in the ShadeGuard MVP.");
    }
    if (request.recipient.kind === "transparent") {
      return result(
        Decision.DENY,
        RiskLevel.HIGH,
        ReasonCode.TRANSPARENT_RECIPIENT_FORBIDDEN,
        "Transparent recipients are forbidden by the testnet privacy policy.",
      );
    }
    if (request.recipient.kind === "unknown" || request.recipient.network !== "testnet") {
      return result(
        Decision.DENY,
        RiskLevel.HIGH,
        ReasonCode.UNKNOWN_RECIPIENT_FORBIDDEN,
        "The recipient could not be verified as a testnet shielded address.",
      );
    }
    if (request.memo && detectSensitiveMemo(request.memo).length > 0) {
      const { memo: _memo, ...withoutMemo } = request;
      return result(
        Decision.REWRITE,
        RiskLevel.HIGH,
        ReasonCode.MEMO_PII_REMOVED,
        "Sensitive memo content was removed; explicitly accept the memo-free request to continue.",
        withoutMemo,
      );
    }
    if (request.amountZatoshi > this.config.maxPerTxZatoshi) {
      return result(
        Decision.DENY,
        RiskLevel.HIGH,
        ReasonCode.PER_TX_LIMIT_EXCEEDED,
        "The payment exceeds the configured per-transaction limit.",
      );
    }
    if (state.spentTodayZatoshi + request.amountZatoshi > this.config.dailyLimitZatoshi) {
      return result(Decision.DENY, RiskLevel.HIGH, ReasonCode.DAILY_LIMIT_EXCEEDED, "The payment would exceed the daily limit.");
    }
    if (
      this.config.allowedRecipientHashes.size > 0 &&
      !this.config.allowedRecipientHashes.has(stableHash(request.recipient.address))
    ) {
      return result(
        Decision.REQUIRE_APPROVAL,
        RiskLevel.HIGH,
        ReasonCode.RECIPIENT_APPROVAL_REQUIRED,
        "The recipient is not on the configured allowlist.",
      );
    }
    if (request.amountZatoshi >= this.config.approvalAboveZatoshi) {
      return result(
        Decision.REQUIRE_APPROVAL,
        RiskLevel.MEDIUM,
        ReasonCode.AMOUNT_APPROVAL_REQUIRED,
        "The amount meets the configured approval threshold.",
      );
    }

    return result(Decision.ALLOW, RiskLevel.LOW, ReasonCode.SAFE_CAPABILITY, "The shielded payment satisfies deterministic policy.");
  }
}
