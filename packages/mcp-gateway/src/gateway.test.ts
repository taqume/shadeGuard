import { InMemoryApprovalService } from "@shadeguard/approval-service";
import {
  Capability,
  DeterministicPolicyEngine,
  MemoryAuditSink,
  canonicalizeRequest,
  parseZec,
} from "@shadeguard/core";
import { MockZcashProvider } from "@shadeguard/zcash-adapter";
import { describe, expect, it } from "vitest";

import { ShadeGuardGateway } from "./gateway.js";

const requester = { agentId: "agent", sessionId: "session" };
const recipient = `utest1${"q".repeat(90)}`;

async function fixture(approvalAbove = "0.05", dailyLimit = "0.50") {
  const provider = new MockZcashProvider(1_342_700_000);
  const audit = new MemoryAuditSink();
  const gateway = new ShadeGuardGateway(
    new DeterministicPolicyEngine({
      maxPerTxZatoshi: parseZec("0.10"),
      dailyLimitZatoshi: parseZec(dailyLimit),
      approvalAboveZatoshi: parseZec(approvalAbove),
      allowedRecipientHashes: new Set(),
    }),
    provider,
    new InMemoryApprovalService(),
    audit,
  );
  await gateway.initialize();
  return { gateway, provider, audit };
}

describe("ShadeGuardGateway", () => {
  it("answers an exact-balance attempt with only an affordability boolean", async () => {
    const { gateway, audit } = await fixture();
    const request = canonicalizeRequest({
      capability: Capability.READ_EXACT_BALANCE,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
    });

    const response = await gateway.execute(request, { acceptSafeRewrite: true });
    const serializedBoundary = JSON.stringify({ response, audit: audit.events });

    expect(response).toMatchObject({ decision: "ALLOW", affordable: true });
    expect(response).not.toHaveProperty("balance");
    expect(serializedBoundary).not.toContain("1342700000");
    expect(serializedBoundary).not.toContain("13.427");
  });

  it("does not call the provider for unknown or forbidden capabilities", async () => {
    const { gateway, provider } = await fixture();
    const before = provider.calls.length;

    const unknown = await gateway.execute(canonicalizeRequest({ capability: Capability.UNKNOWN, requester }));
    const viewingKey = await gateway.execute(
      canonicalizeRequest({ capability: Capability.EXPORT_VIEWING_KEY, requester }),
    );

    expect(unknown.decision).toBe("DENY");
    expect(viewingKey.decision).toBe("DENY");
    expect(provider.calls).toHaveLength(before);
  });

  it("requires explicit acceptance before executing a memo-free rewrite", async () => {
    const { gateway, provider, audit } = await fixture();
    const input = {
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
      recipient,
      memo: "receipt: alice@example.com",
    } as const;

    const proposal = await gateway.execute(canonicalizeRequest(input));
    expect(proposal).toMatchObject({
      decision: "REWRITE",
      safeAlternative: { capability: Capability.SEND_SHIELDED, memoRemoved: true },
    });
    expect(provider.calls).not.toContain("SEND_SHIELDED");

    const accepted = await gateway.execute(canonicalizeRequest(input), { acceptSafeRewrite: true });
    expect(accepted).toMatchObject({ decision: "ALLOW", payment: { status: "SUBMITTED" } });
    expect(provider.calls).toContain("SEND_SHIELDED");
    expect(JSON.stringify({ proposal, accepted, audit: audit.events })).not.toContain("alice@example.com");
  });

  it("resumes a user-approved request exactly once", async () => {
    const { gateway, provider } = await fixture("0.005");
    const request = canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
      recipient,
    });
    const pending = await gateway.execute(request);
    expect(pending.decision).toBe("REQUIRE_APPROVAL");
    const approvalId = pending.approval?.id;
    if (!approvalId) throw new Error("Test expected approval ID");

    gateway.approve(approvalId);
    const executed = await gateway.resumeApproved(request.id, requester);

    expect(executed).toMatchObject({ decision: "ALLOW", payment: { status: "SUBMITTED" } });
    expect(provider.calls.filter((call) => call === "SEND_SHIELDED")).toHaveLength(1);
    await expect(gateway.resumeApproved(request.id, requester)).rejects.toThrow("not approved");
  });

  it("serializes concurrent payments so they cannot race past the daily limit", async () => {
    const { gateway, provider } = await fixture("0.05", "0.015");
    const input = {
      capability: Capability.SEND_SHIELDED,
      requester,
      purpose: "purchase API",
      amountZec: "0.01",
      recipient,
    } as const;

    const results = await Promise.all([
      gateway.execute(canonicalizeRequest(input)),
      gateway.execute(canonicalizeRequest(input)),
    ]);

    expect(results.map((result) => result.decision).sort()).toEqual(["ALLOW", "DENY"]);
    expect(results.some((result) => result.reasonCode === "DAILY_LIMIT_EXCEEDED")).toBe(true);
    expect(provider.calls.filter((call) => call === "SEND_SHIELDED")).toHaveLength(1);
  });
});
