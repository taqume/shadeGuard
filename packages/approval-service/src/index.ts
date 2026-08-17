import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { CanonicalRequest, PolicyResult } from "@shadeguard/core";

export type ApprovalStatus = "PENDING" | "APPROVED" | "CONSUMED" | "EXPIRED";

export interface ApprovalSummary {
  readonly id: string;
  readonly requestId: string;
  readonly capability: string;
  readonly reasonCode: string;
  readonly risk: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly amountZatoshi?: number;
  readonly purpose?: string;
  readonly recipient?: string;
  readonly recipientHash?: string;
  readonly memoPresent: boolean;
}

interface ApprovalRecord extends Omit<ApprovalSummary, "status"> {
  status: ApprovalStatus;
  readonly requestDigest: string;
  tokenDigest?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestRequest(request: CanonicalRequest): string {
  return digest(
    JSON.stringify({
      id: request.id,
      capability: request.capability,
      requester: request.requester,
      createdAt: request.createdAt,
      purpose: request.purpose ?? null,
      amountZatoshi: request.amountZatoshi ?? null,
      recipient: request.recipient ?? null,
      memo: request.memo ?? null,
      paymentId: request.paymentId ?? null,
    }),
  );
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class InMemoryApprovalService {
  private readonly records = new Map<string, ApprovalRecord>();

  public constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  public create(request: CanonicalRequest, policy: PolicyResult): ApprovalSummary {
    if (policy.decision !== "REQUIRE_APPROVAL") {
      throw new Error("An approval can only be created for REQUIRE_APPROVAL decisions");
    }

    const createdAtMs = this.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      requestId: request.id,
      capability: request.capability,
      reasonCode: policy.reasonCode,
      risk: policy.risk,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      status: "PENDING",
      requestDigest: digestRequest(request),
      memoPresent: request.memo !== undefined && request.memo.length > 0,
      ...(request.amountZatoshi === undefined ? {} : { amountZatoshi: request.amountZatoshi }),
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
      ...(request.recipient === undefined
        ? {}
        : { recipient: request.recipient.address, recipientHash: digest(request.recipient.address) }),
    };
    this.records.set(record.id, record);
    return this.toSummary(record);
  }

  public approve(id: string): string {
    const record = this.getActive(id);
    if (record.status !== "PENDING") {
      throw new Error("Approval is not pending");
    }

    const secret = randomBytes(32).toString("base64url");
    const token = `${record.id}.${secret}`;
    record.tokenDigest = digest(token);
    record.status = "APPROVED";
    return token;
  }

  public consume(token: string, request: CanonicalRequest): void {
    const separator = token.indexOf(".");
    if (separator <= 0) {
      throw new Error("Invalid approval token");
    }

    const id = token.slice(0, separator);
    const record = this.getActive(id);
    if (record.status !== "APPROVED" || record.tokenDigest === undefined) {
      throw new Error("Approval token is not active");
    }
    if (!safeEqualHex(record.tokenDigest, digest(token))) {
      throw new Error("Invalid approval token");
    }
    if (!safeEqualHex(record.requestDigest, digestRequest(request))) {
      throw new Error("Approval does not match this request");
    }

    record.status = "CONSUMED";
    delete record.tokenDigest;
  }

  public list(): readonly ApprovalSummary[] {
    return [...this.records.values()].map((record) => {
      this.expireIfNeeded(record);
      return this.toSummary(record);
    });
  }

  private getActive(id: string): ApprovalRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new Error("Approval was not found");
    }
    this.expireIfNeeded(record);
    if (record.status === "EXPIRED") {
      throw new Error("Approval has expired");
    }
    return record;
  }

  private expireIfNeeded(record: ApprovalRecord): void {
    if ((record.status === "PENDING" || record.status === "APPROVED") && this.now() >= Date.parse(record.expiresAt)) {
      record.status = "EXPIRED";
      delete record.tokenDigest;
    }
  }

  private toSummary(record: ApprovalRecord): ApprovalSummary {
    return {
      id: record.id,
      requestId: record.requestId,
      capability: record.capability,
      reasonCode: record.reasonCode,
      risk: record.risk,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      status: record.status,
      memoPresent: record.memoPresent,
      ...(record.amountZatoshi === undefined ? {} : { amountZatoshi: record.amountZatoshi }),
      ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      ...(record.recipient === undefined ? {} : { recipient: record.recipient }),
      ...(record.recipientHash === undefined ? {} : { recipientHash: record.recipientHash }),
    };
  }
}
