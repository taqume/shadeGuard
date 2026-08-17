import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryApprovalService } from "@shadeguard/approval-service";
import {
  Capability,
  DeterministicPolicyEngine,
  MemoryAuditSink,
  canonicalizeRequest,
  parseZec,
} from "@shadeguard/core";
import { MockZcashProvider } from "@shadeguard/zcash-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalControlServer, sendApprovalCommand } from "./approval-control.js";
import { ShadeGuardGateway } from "./gateway.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ApprovalControlServer", () => {
  it("exposes pending metadata over a user-only socket without exposing approval tokens", async () => {
    const provider = new MockZcashProvider();
    const gateway = new ShadeGuardGateway(
      new DeterministicPolicyEngine({
        maxPerTxZatoshi: parseZec("0.10"),
        dailyLimitZatoshi: parseZec("0.50"),
        approvalAboveZatoshi: parseZec("0.005"),
        allowedRecipientHashes: new Set(),
      }),
      provider,
      new InMemoryApprovalService(),
      new MemoryAuditSink(),
    );
    await gateway.initialize();
    const request = canonicalizeRequest({
      capability: Capability.SEND_SHIELDED,
      requester: { agentId: "agent", sessionId: "session" },
      purpose: "purchase API",
      amountZec: "0.01",
      recipient: `utest1${"q".repeat(90)}`,
    });
    const pending = await gateway.execute(request);
    const approvalId = pending.approval?.id;
    if (!approvalId) throw new Error("Expected a pending approval");

    const directory = await mkdtemp(join(tmpdir(), "shadeguard-approval-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "approval.sock");
    const control = new ApprovalControlServer(gateway, socketPath);
    await control.start();
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      const listed = await sendApprovalCommand(socketPath, { action: "list" });
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed)).toContain(approvalId);
      expect(JSON.stringify(listed)).toContain(request.recipient?.address ?? "missing-recipient");
      expect(JSON.stringify(listed)).toContain("purchase API");
      expect(JSON.stringify(listed)).not.toMatch(/tokenDigest|approvalToken/iu);

      const approved = await sendApprovalCommand(socketPath, { action: "approve", approvalId });
      expect(approved).toEqual({ ok: true, result: { requestId: request.id } });

      const resumed = await gateway.resumeApproved(request.id, request.requester);
      expect(resumed).toMatchObject({ decision: "ALLOW", payment: { status: "SUBMITTED" } });
    } finally {
      await control.close();
    }
  });
});
