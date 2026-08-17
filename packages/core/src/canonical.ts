import { randomUUID } from "node:crypto";

import { parseZec } from "./money.js";
import { classifyRecipient } from "./privacy.js";
import type { CanonicalRequest, Capability, RequesterContext } from "./types.js";

export interface CanonicalRequestInput {
  readonly capability: Capability;
  readonly requester: RequesterContext;
  readonly purpose?: string;
  readonly amountZec?: string | number;
  readonly recipient?: string;
  readonly memo?: string;
  readonly paymentId?: string;
}

export function canonicalizeRequest(input: CanonicalRequestInput): CanonicalRequest {
  const base: CanonicalRequest = {
    id: randomUUID(),
    capability: input.capability,
    requester: input.requester,
    createdAt: new Date().toISOString(),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose.trim() }),
    ...(input.amountZec === undefined ? {} : { amountZatoshi: parseZec(input.amountZec) }),
    ...(input.recipient === undefined ? {} : { recipient: classifyRecipient(input.recipient) }),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(input.paymentId === undefined ? {} : { paymentId: input.paymentId.trim() }),
  };

  return base;
}
