import { canonicalizeRequest, Capability, parseZec } from "@shadeguard/core";
import { describe, expect, it } from "vitest";

import { InMemoryApprovalService } from "./index.js";

const requester = { agentId: "agent", sessionId: "session" };
const policy = {
  decision: "REQUIRE_APPROVAL",
  risk: "HIGH",
  reasonCode: "RECIPIENT_APPROVAL_REQUIRED",
  explanation: "approval required",
} as const;

function payment(amount = "0.01", recipient = `utest1${"q".repeat(90)}`) {
  return canonicalizeRequest({
    capability: Capability.SEND_SHIELDED,
    requester,
    purpose: "purchase API",
    amountZec: amount,
    recipient,
  });
}

describe("InMemoryApprovalService", () => {
  it("binds a one-use token to the exact canonical request", () => {
    const service = new InMemoryApprovalService();
    const request = payment();
    const pending = service.create(request, policy);
    const token = service.approve(pending.id);

    service.consume(token, request);

    expect(service.list()[0]?.status).toBe("CONSUMED");
    expect(() => service.consume(token, request)).toThrow("not active");
  });

  it("rejects amount and recipient substitution", () => {
    const service = new InMemoryApprovalService();
    const request = payment();
    const token = service.approve(service.create(request, policy).id);
    const changed = {
      ...request,
      amountZatoshi: parseZec("0.02"),
    };

    expect(() => service.consume(token, changed)).toThrow("does not match");
    expect(() => service.consume(token, { ...request, recipient: payment("0.01", `utest1${"p".repeat(90)}`).recipient })).toThrow(
      "does not match",
    );
  });

  it("expires pending approvals", () => {
    let now = 1_000;
    const service = new InMemoryApprovalService(100, () => now);
    const request = payment();
    const id = service.create(request, policy).id;
    now = 1_101;

    expect(() => service.approve(id)).toThrow("expired");
    expect(service.list()[0]?.status).toBe("EXPIRED");
  });
});
