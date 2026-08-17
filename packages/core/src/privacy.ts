import { createHash } from "node:crypto";

import type { Recipient } from "./types.js";

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/u;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const LABELED_SECRET = /\b(?:api[_ -]?key|private[_ -]?key|seed(?: phrase)?|viewing[_ -]?key|password|bearer)\b\s*[:=]/iu;
const LONG_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{40,})\b/u;

export type SensitiveMemoFinding = "EMAIL" | "PHONE" | "UUID" | "LABELED_SECRET" | "TOKEN";

export function detectSensitiveMemo(memo: string): readonly SensitiveMemoFinding[] {
  const findings: SensitiveMemoFinding[] = [];
  if (EMAIL.test(memo)) findings.push("EMAIL");
  if (PHONE.test(memo)) findings.push("PHONE");
  if (UUID.test(memo)) findings.push("UUID");
  if (LABELED_SECRET.test(memo)) findings.push("LABELED_SECRET");
  if (LONG_TOKEN.test(memo)) findings.push("TOKEN");
  return findings;
}

export function classifyRecipient(address: string): Recipient {
  const normalized = address.trim();

  if (normalized.startsWith("utest1") || normalized.startsWith("ztestsapling")) {
    return { address: normalized, kind: "shielded", network: "testnet" };
  }
  if (normalized.startsWith("u1") || normalized.startsWith("zs1")) {
    return { address: normalized, kind: "shielded", network: "mainnet" };
  }
  if (normalized.startsWith("tm") || normalized.startsWith("t2") || normalized.startsWith("textest1")) {
    return { address: normalized, kind: "transparent", network: "testnet" };
  }
  if (normalized.startsWith("t1") || normalized.startsWith("t3") || normalized.startsWith("tex1")) {
    return { address: normalized, kind: "transparent", network: "mainnet" };
  }

  return { address: normalized, kind: "unknown", network: "unknown" };
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
