import { stableHash } from "./privacy.js";
import type { CanonicalRequest, PolicyResult } from "./types.js";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEvent {
  readonly timestamp: string;
  readonly requestId: string;
  readonly requesterId: string;
  readonly capability: string;
  readonly decision: string;
  readonly risk: string;
  readonly reasonCode: string;
  readonly provider?: string;
  readonly outcome?: "POLICY_ONLY" | "EXECUTED" | "FAILED";
  readonly amountZatoshi?: number;
  readonly recipientHash?: string;
  readonly memoPresent: boolean;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export function createAuditEvent(
  request: CanonicalRequest,
  policy: PolicyResult,
  options: { readonly provider?: string; readonly outcome?: AuditEvent["outcome"] } = {},
): AuditEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: request.id,
    requesterId: request.requester.agentId,
    capability: request.capability,
    decision: policy.decision,
    risk: policy.risk,
    reasonCode: policy.reasonCode,
    memoPresent: request.memo !== undefined && request.memo.length > 0,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(request.amountZatoshi === undefined ? {} : { amountZatoshi: request.amountZatoshi }),
    ...(request.recipient === undefined ? {} : { recipientHash: stableHash(request.recipient.address) }),
  };
}

export class MemoryAuditSink implements AuditSink {
  public readonly events: AuditEvent[] = [];

  public async write(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

export class JsonlAuditSink implements AuditSink {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async write(event: AuditEvent): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.writeQueue;
  }
}
