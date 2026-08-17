#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";

import { ApprovalControlServer } from "./approval-control.js";
import { createShadeGuardMcpServer } from "./mcp.js";
import { createRuntimeGateway } from "./runtime.js";

async function main(): Promise<void> {
  const gateway = await createRuntimeGateway();
  const approvalControl = new ApprovalControlServer(
    gateway,
    resolve(process.env.SHADEGUARD_APPROVAL_SOCKET ?? ".shadeguard/approval.sock"),
  );
  await approvalControl.start();
  const mcp = serveStdio(() => createShadeGuardMcpServer(gateway), {
    onerror: (error) => console.error(`[shadeguard] MCP transport error: ${error.message}`),
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([mcp.close(), approvalControl.close(), gateway.close()]);
  };
  process.stdin.once("end", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  console.error(`[shadeguard] Startup failed: ${message}`);
  process.exitCode = 1;
});
