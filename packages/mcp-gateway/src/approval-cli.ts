#!/usr/bin/env node
import { resolve } from "node:path";

import { sendApprovalCommand } from "./approval-control.js";

async function main(): Promise<void> {
  const action = process.argv[2];
  const socketPath = resolve(process.env.SHADEGUARD_APPROVAL_SOCKET ?? ".shadeguard/approval.sock");
  if (action === "list") {
    const response = await sendApprovalCommand(socketPath, { action: "list" });
    if (!response.ok) throw new Error(response.error ?? "Approval list failed");
    console.log(JSON.stringify(response.result, null, 2));
    return;
  }
  if (action === "approve") {
    const approvalId = process.argv[3];
    if (!approvalId) throw new Error("Usage: shadeguard-approval approve <approval-id>");
    const response = await sendApprovalCommand(socketPath, { action: "approve", approvalId });
    if (!response.ok) throw new Error(response.error ?? "Approval failed");
    console.log(JSON.stringify(response.result, null, 2));
    return;
  }
  throw new Error("Usage: shadeguard-approval <list|approve> [approval-id]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown approval CLI failure";
  console.error(`ShadeGuard approval CLI: ${message}`);
  process.exitCode = 1;
});
