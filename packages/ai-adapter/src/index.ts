import { Capability } from "@shadeguard/core";
import { z } from "zod";

export interface IntentInput {
  readonly instruction: string;
  readonly requesterId: string;
}

export interface IntentProposal {
  readonly capability: string;
  readonly purpose: string;
  readonly amountZec?: string;
  readonly recipient?: string;
  readonly paymentId?: string;
  readonly explanation: string;
}

export interface StructuredIntent extends Omit<IntentProposal, "capability"> {
  readonly capability: Capability;
  readonly source: "deterministic" | "llm";
  /** Kept local and never produced by the LLM provider. */
  readonly memo?: string;
}

/**
 * An LLM can propose intent and an explanation. The interface deliberately has
 * no policy decision, risk override, wallet context, or execution method.
 */
export interface LLMProvider {
  proposeIntent(input: IntentInput): Promise<IntentProposal>;
}

const intentProposalSchema = z.object({
  capability: z.string().min(1).max(80),
  purpose: z.string().min(1).max(200),
  amountZec: z.string().regex(/^\d+(?:\.\d{1,8})?$/u).optional(),
  recipient: z.string().min(10).max(300).optional(),
  paymentId: z.string().min(1).max(200).optional(),
  explanation: z.string().min(1).max(500),
}).strict();

const capabilities = new Set<string>(Object.values(Capability));
const capabilitySecurityOrder: readonly Capability[] = [
  Capability.EXPORT_SPENDING_KEY,
  Capability.EXPORT_VIEWING_KEY,
  Capability.LIST_TRANSACTIONS,
  Capability.READ_EXACT_BALANCE,
  Capability.SEND_SHIELDED,
  Capability.GET_PAYMENT_STATUS,
  Capability.GET_RECEIVE_ADDRESS,
  Capability.CAN_AFFORD,
  Capability.UNKNOWN,
];

const INTENT_SYSTEM_INSTRUCTION = `You are ShadeGuard's intent parser, not its security authority.
Convert the user's Zcash-related instruction into exactly one canonical capability.
Allowed capabilities: ${Object.values(Capability).join(", ")}.
Never make ALLOW, DENY, approval, risk, or execution decisions.
Never ask for or infer a seed phrase, key, exact wallet balance, or transaction history.
Copy an amount, recipient, or payment ID only when explicitly present. Never invent one.
Use UNKNOWN when no capability is clearly supported by the instruction.
Write a concise purpose and explain what you interpreted in the user's language.
Return only a JSON object with capability, purpose, explanation and any explicitly present amountZec, recipient or paymentId.`;

interface NvidiaNimHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface NvidiaNimFetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type NvidiaNimFetch = (url: string, init: NvidiaNimFetchInit) => Promise<NvidiaNimHttpResponse>;

export interface NvidiaNimProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetcher?: NvidiaNimFetch;
  readonly timeoutMs?: number;
}

const NVIDIA_NIM_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const nvidiaNimResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().min(1) }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

/** NVIDIA's hosted NIM endpoint is used only as an untrusted intent parser. */
export class NvidiaNimLLMProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: NvidiaNimFetch;
  private readonly timeoutMs: number;

  public constructor(options: NvidiaNimProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("NVIDIA NIM API key is required");
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || "meta/llama-3.1-8b-instruct";
    this.fetcher = options.fetcher ?? (async (url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error("NVIDIA NIM timeout is invalid");
    }
  }

  public async proposeIntent(input: IntentInput): Promise<IntentProposal> {
    const instruction = input.instruction.trim();
    if (!instruction || instruction.length > 4_000) throw new Error("Agent instruction is empty or too long");
    const response = await this.fetcher(NVIDIA_NIM_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: INTENT_SYSTEM_INSTRUCTION },
          { role: "user", content: instruction },
        ],
        temperature: 0,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`NVIDIA NIM request failed with HTTP ${response.status}`);
    const envelope = nvidiaNimResponseSchema.parse(await response.json());
    const content = envelope.choices[0]?.message.content;
    if (!content) throw new Error("NVIDIA NIM returned no structured intent");
    const parsed = parseNvidiaIntentProposal(content);
    return {
      capability: parsed.capability,
      purpose: parsed.purpose,
      explanation: parsed.explanation,
      ...(parsed.amountZec === undefined ? {} : { amountZec: parsed.amountZec }),
      ...(parsed.recipient === undefined ? {} : { recipient: parsed.recipient }),
      ...(parsed.paymentId === undefined ? {} : { paymentId: parsed.paymentId }),
    };
  }
}

function parseNvidiaIntentProposal(content: string): z.infer<typeof intentProposalSchema> {
  const trimmed = content.trim();
  const candidates = new Set<string>([
    trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, ""),
    ...extractJsonObjects(trimmed),
  ]);
  const proposals: Array<z.infer<typeof intentProposalSchema>> = [];
  for (const candidate of candidates) {
    try {
      const decoded = JSON.parse(candidate) as unknown;
      const parsed = intentProposalSchema.safeParse(normalizeProviderIntentPayload(decoded));
      if (parsed.success) proposals.push(parsed.data);
    } catch {
      // A response may contain prose or several fenced objects; invalid candidates are ignored.
    }
  }
  if (proposals.length === 0) throw new Error("NVIDIA NIM returned invalid JSON intent");
  const known = proposals.filter((proposal) => capabilities.has(proposal.capability));
  const selectable = known.length > 0 ? known : proposals;
  return selectable.reduce((selected, proposal) => {
    const selectedRank = capabilitySecurityOrder.indexOf(selected.capability as Capability);
    const proposalRank = capabilitySecurityOrder.indexOf(proposal.capability as Capability);
    return proposalRank >= 0 && (selectedRank < 0 || proposalRank < selectedRank) ? proposal : selected;
  });
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function normalizeProviderIntentPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of ["amountZec", "recipient", "paymentId"] as const) {
    if (normalized[field] === null) delete normalized[field];
  }
  if (typeof normalized.amountZec === "number" && Number.isFinite(normalized.amountZec) && normalized.amountZec >= 0) {
    normalized.amountZec = normalized.amountZec
      .toFixed(8)
      .replace(/(?:\.0+|(?<=[0-9])0+)$/u, "")
      .replace(/\.$/u, "");
  }
  if (typeof normalized.capability === "string" && !capabilities.has(normalized.capability)) {
    const tokens = new Set(normalized.capability.toUpperCase().split(/[^A-Z_]+/u).filter(Boolean));
    const selected = capabilitySecurityOrder.find((capability) => tokens.has(capability));
    if (selected) normalized.capability = selected;
  }
  return normalized;
}

export interface ConfiguredIntentAnalyzer {
  readonly analyzer: IntentAnalyzer;
  readonly provider: "nvidia" | "deterministic";
  readonly model?: string;
}

export function createIntentAnalyzerFromEnv(env: NodeJS.ProcessEnv = process.env): ConfiguredIntentAnalyzer {
  const requested = env.AI_PROVIDER?.trim().toLowerCase() ?? "none";
  const nvidiaApiKey = env.NVIDIA_API_KEY?.trim();
  if (requested === "nvidia" && nvidiaApiKey) {
    const model = env.NVIDIA_MODEL?.trim() || "meta/llama-3.1-8b-instruct";
    return {
      analyzer: new IntentAnalyzer(new NvidiaNimLLMProvider({ apiKey: nvidiaApiKey, model })),
      provider: "nvidia",
      model,
    };
  }
  return { analyzer: new IntentAnalyzer(), provider: "deterministic" };
}

export class IntentAnalyzer {
  public constructor(private readonly llm?: LLMProvider) {}

  public async analyze(input: IntentInput): Promise<StructuredIntent> {
    if (!input.instruction.trim()) {
      return this.normalize({
        capability: Capability.UNKNOWN,
        purpose: "empty instruction",
        explanation: "No task intent was provided.",
      }, "deterministic");
    }
    const localMemo = extractLocalMemo(input.instruction);
    const privacySafeInstruction = localMemo === undefined
      ? input.instruction
      : input.instruction.replace(localMemo, "[MEMO REDACTED LOCALLY]");
    if (this.llm) {
      const proposal = await this.llm.proposeIntent({
        requesterId: input.requesterId,
        instruction: privacySafeInstruction,
      });
      return this.withLocalMemo(this.normalize(proposal, "llm"), localMemo);
    }
    return this.withLocalMemo(this.deterministic(privacySafeInstruction), localMemo);
  }

  private deterministic(instruction: string): StructuredIntent {
    const normalized = instruction.toLocaleLowerCase("en-US");
    let capability: Capability = Capability.UNKNOWN;

    if (/viewing[ _-]?key|görüntüleme anahtarı/u.test(normalized)) capability = Capability.EXPORT_VIEWING_KEY;
    else if (/(?:spending|private)[ _-]?key|seed phrase|mnemonic|harcama anahtarı|özel anahtar/u.test(normalized)) {
      capability = Capability.EXPORT_SPENDING_KEY;
    } else if (/transaction history|all transactions|full history|işlem geçmişi|bütün işlemler|tüm işlemler/u.test(normalized)) {
      capability = Capability.LIST_TRANSACTIONS;
    } else if (/exact balance|wallet balance|how much.*wallet|tam bakiye|cüzdan bakiyesi/u.test(normalized)) {
      capability = Capability.READ_EXACT_BALANCE;
    } else if (/payment status|transaction status|ödeme durumu|işlem durumu/u.test(normalized)) {
      capability = Capability.GET_PAYMENT_STATUS;
    } else if (/can (?:i|we|the wallet) afford|affordability|karşılayabilir|yeterli bakiye|ödeyebilir/u.test(normalized)) {
      capability = Capability.CAN_AFFORD;
    } else if (/\b(?:send|pay|buy|purchase|gönder|öde|satın al)\b/u.test(normalized)) {
      capability = Capability.SEND_SHIELDED;
    }

    const amount = /\b(\d+(?:\.\d{1,8})?)\s*(?:(?:testnet|test)\s*)?(?:zec|tzec)\b/iu.exec(instruction)?.[1];
    const recipient = /\b(?:utest1|ztestsapling)[a-z0-9]+\b/iu.exec(instruction)?.[0];
    const paymentId = /\b[0-9a-f]{64}\b/iu.exec(instruction)?.[0];
    return this.normalize(
      {
        capability,
        purpose: instruction.slice(0, 200),
        explanation: "Intent was classified locally without sending wallet context to an AI provider.",
        ...(amount === undefined ? {} : { amountZec: amount }),
        ...(recipient === undefined ? {} : { recipient }),
        ...(paymentId === undefined ? {} : { paymentId }),
      },
      "deterministic",
    );
  }

  private normalize(proposal: IntentProposal, source: StructuredIntent["source"]): StructuredIntent {
    const capability = capabilities.has(proposal.capability)
      ? (proposal.capability as Capability)
      : Capability.UNKNOWN;
    return {
      capability,
      source,
      purpose: proposal.purpose.slice(0, 200),
      explanation: proposal.explanation.slice(0, 500),
      ...(proposal.amountZec === undefined ? {} : { amountZec: proposal.amountZec }),
      ...(proposal.recipient === undefined ? {} : { recipient: proposal.recipient }),
      ...(proposal.paymentId === undefined ? {} : { paymentId: proposal.paymentId }),
    };
  }

  private withLocalMemo(intent: StructuredIntent, memo: string | undefined): StructuredIntent {
    return memo === undefined ? intent : { ...intent, memo };
  }
}

function extractLocalMemo(instruction: string): string | undefined {
  const match = /\bmemo(?:\s+(?:alanına|alanina|field|olarak))?\s*(?:'?(?:ya|ye)|:)?\s+(.+)$/iu.exec(instruction);
  const captured = match?.[1]?.trim();
  if (!captured) return undefined;
  const cleaned = captured
    .replace(/[.;]\s*$/u, "")
    .replace(/\s+(?:yaz|ekle|write|include)$/iu, "")
    .replace(/[.;]\s*$/u, "")
    .trim();
  return cleaned || undefined;
}
