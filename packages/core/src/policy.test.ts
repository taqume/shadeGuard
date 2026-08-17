import { describe, expect, it } from "vitest";

import { createAuditEvent } from "./audit.js";
import { canonicalizeRequest } from "./canonical.js";
import { parseZec } from "./money.js";
import { DeterministicPolicyEngine } from "./policy.js";
import { Capability, Decision, ReasonCode, RiskLevel } from "./types.js";

const requester = { agentId: "test-agent", sessionId: "session-1" };
const testnetRecipient = `utest1${"q".repeat(90)}`;

function engine(allowedRecipientHashes: ReadonlySet<string> = new Set()): DeterministicPolicyEngine {
  return new DeterministicPolicyEngine({
    maxPerTxZatoshi: parseZec("0.10"),
    dailyLimitZatoshi: parseZec("0.50"),
    approvalAboveZatoshi: parseZec("0.05"),
    allowedRecipientHashes,
  });
}

describe("DeterministicPolicyEngine", () => {
  it("rewrites an exact balance request to a boolean affordability capability", () => {
    const request = canonicalizeRequest({
      capability: Capability.READ_EXACT_BALANCE,
      requester,
      amountZec: "0.01",
      purpose: "purchase weather API",
    });

    const outcome = engine().evaluate(request, { spentTodayZatoshi: 0 });

    expect(outcome.decision).toBe(Decision.REWRITE);
    expect(outcome.reasonCode).toBe(ReasonCode.EXACT_BALANCE_REWRITTEN);
    expect(outcome.rewrittenRequest?.capability).toBe(Capability.CAN_AFFORD);
    expect(JSON.stringify(outcome)).not.toContain("13.427");
  });

  it.each([Capability.EXPORT_VIEWING_KEY, Capability.EXPORT_SPENDING_KEY])(
    "critically denies %s without an approval escape hatch",
    (capability) => {
      const request = canonicalizeRequest({ capability, requester, purpose: "agent asked for everything" });
      const outcome = engine().evaluate(request, { spentTodayZatoshi: 0 });

      expect(outcome).toMatchObject({
        decision: Decision.DENY,
        risk: RiskLevel.CRITICAL,
        reasonCode: ReasonCode.KEY_EXPORT_FORBIDDEN,
      });
    },
  );

  it("fails closed for unknown capabilities", () => {
    const request = canonicalizeRequest({ capability: Capability.UNKNOWN, requester });
    expect(engine().evaluate(request, { spentTodayZatoshi: 0 })).toMatchObject({
      decision: Decision.DENY,
      risk: RiskLevel.CRITICAL,
      reasonCode: ReasonCode.UNKNOWN_CAPABILITY,
    });
  });

  it("removes a PII memo and does not include its content in audit output", () => {
    const secretMemo = "send the receipt to alice@example.com";
    const request = canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
      recipient: testnetRecipient,
      memo: secretMemo,
    });
    const outcome = engine().evaluate(request, { spentTodayZatoshi: 0 });
    const audit = createAuditEvent(request, outcome);

    expect(outcome.decision).toBe(Decision.REWRITE);
    expect(outcome.reasonCode).toBe(ReasonCode.MEMO_PII_REMOVED);
    expect(outcome.rewrittenRequest).not.toHaveProperty("memo");
    expect(JSON.stringify(audit)).not.toContain(secretMemo);
    expect(JSON.stringify(outcome)).not.toContain(secretMemo);
  });

  it("denies transparent and mainnet recipients before spending checks", () => {
    const transparent = canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "999",
      recipient: `tm${"a".repeat(33)}`,
    });
    const mainnet = canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
      recipient: `u1${"a".repeat(100)}`,
    });

    expect(engine().evaluate(transparent, { spentTodayZatoshi: 0 }).reasonCode).toBe(
      ReasonCode.TRANSPARENT_RECIPIENT_FORBIDDEN,
    );
    expect(engine().evaluate(mainnet, { spentTodayZatoshi: 0 }).reasonCode).toBe(ReasonCode.MAINNET_FORBIDDEN);
  });

  it("enforces per-transaction, daily, and approval thresholds", () => {
    const base = {
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      recipient: testnetRecipient,
    } as const;

    expect(
      engine().evaluate(canonicalizeRequest({ ...base, amountZec: "0.11" }), { spentTodayZatoshi: 0 }).reasonCode,
    ).toBe(ReasonCode.PER_TX_LIMIT_EXCEEDED);
    expect(
      engine().evaluate(canonicalizeRequest({ ...base, amountZec: "0.02" }), {
        spentTodayZatoshi: parseZec("0.49"),
      }).reasonCode,
    ).toBe(ReasonCode.DAILY_LIMIT_EXCEEDED);
    expect(
      engine().evaluate(canonicalizeRequest({ ...base, amountZec: "0.05" }), { spentTodayZatoshi: 0 }).reasonCode,
    ).toBe(ReasonCode.AMOUNT_APPROVAL_REQUIRED);
    expect(
      engine().evaluate(canonicalizeRequest({ ...base, amountZec: "0.01" }), { spentTodayZatoshi: 0 }).decision,
    ).toBe(Decision.ALLOW);
  });
});
