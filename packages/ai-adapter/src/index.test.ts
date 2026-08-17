import { Capability } from "@shadeguard/core";
import { describe, expect, it } from "vitest";

import {
  createIntentAnalyzerFromEnv,
  GeminiLLMProvider,
  IntentAnalyzer,
  NvidiaNimLLMProvider,
  type LLMProvider,
} from "./index.js";

describe("IntentAnalyzer", () => {
  it("runs without an API key and preserves dangerous intent for deterministic denial", async () => {
    const analyzer = new IntentAnalyzer();

    await expect(
      analyzer.analyze({ instruction: "Export the wallet viewing key", requesterId: "agent" }),
    ).resolves.toMatchObject({ capability: Capability.EXPORT_VIEWING_KEY, source: "deterministic" });
    await expect(
      analyzer.analyze({ instruction: "Buy the API for 0.01 ZEC", requesterId: "agent" }),
    ).resolves.toMatchObject({ capability: Capability.SEND_SHIELDED, amountZec: "0.01" });
  });

  it("normalizes an LLM's invented capability to UNKNOWN and has no decision channel", async () => {
    const llm: LLMProvider = {
      async proposeIntent() {
        return {
          capability: "SUPERUSER_ALLOW",
          purpose: "do everything",
          explanation: "model suggestion",
        };
      },
    };

    const intent = await new IntentAnalyzer(llm).analyze({ instruction: "do everything", requesterId: "agent" });

    expect(intent.capability).toBe(Capability.UNKNOWN);
    expect(intent).not.toHaveProperty("decision");
  });

  it("uses Gemini only for structured intent and sends no requester or wallet context", async () => {
    const requests: unknown[] = [];
    const gemini = new GeminiLLMProvider({
      apiKey: "test-only",
      model: "gemini-test",
      client: {
        models: {
          async generateContent(request) {
            requests.push(request);
            return {
              text: JSON.stringify({
                capability: Capability.READ_EXACT_BALANCE,
                purpose: "Ödeme gücünü kontrol et",
                amountZec: "0.01",
                explanation: "Tam bakiye yerine ödeme yeterliliği isteniyor.",
              }),
            };
          },
        },
      },
    });

    const intent = await new IntentAnalyzer(gemini).analyze({
      instruction: "0.01 ZEC için tam bakiyemi getir",
      requesterId: "private-agent-id",
    });

    expect(intent).toMatchObject({ capability: Capability.READ_EXACT_BALANCE, source: "llm" });
    expect(JSON.stringify(requests)).not.toContain("private-agent-id");
    expect(intent).not.toHaveProperty("decision");
  });

  it("removes an explicit memo from Gemini context while preserving it for local policy", async () => {
    const requests: unknown[] = [];
    const gemini = new GeminiLLMProvider({
      apiKey: "test-only",
      client: {
        models: {
          async generateContent(request) {
            requests.push(request);
            return {
              text: JSON.stringify({
                capability: Capability.SEND_SHIELDED,
                purpose: "Testnet ödeme",
                amountZec: "0.01",
                explanation: "Shielded ödeme isteği.",
              }),
            };
          },
        },
      },
    });

    const intent = await new IntentAnalyzer(gemini).analyze({
      instruction: "0.01 ZEC gönder; memo alanına alice@example.com yaz.",
      requesterId: "agent",
    });

    expect(intent.memo).toBe("alice@example.com");
    expect(intent.purpose).not.toContain("alice@example.com");
    expect(JSON.stringify(requests)).not.toContain("alice@example.com");
    expect(JSON.stringify(requests)).toContain("MEMO REDACTED LOCALLY");
  });

  it("uses NVIDIA NIM as an untrusted structured parser without sending requester identity", async () => {
    const requests: Array<{ url: string; body: string; authorization: string | undefined }> = [];
    const nvidia = new NvidiaNimLLMProvider({
      apiKey: "nvapi-test-only",
      model: "meta/llama-3.1-8b-instruct",
      fetcher: async (url, init) => {
        requests.push({ url, body: init.body, authorization: init.headers.Authorization });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [{
                message: {
                  content: `Intent proposal follows:\n\`\`\`json\n${JSON.stringify({
                    capability: Capability.CAN_AFFORD,
                    purpose: "0.02 ZEC ödeme yeterliliğini kontrol et",
                    amountZec: 0.02,
                    recipient: null,
                    paymentId: null,
                    explanation: "Tam bakiye gerektirmeyen yeterlilik kontrolü.",
                  })}\n\`\`\``,
                },
              }],
            };
          },
        };
      },
    });

    const intent = await new IntentAnalyzer(nvidia).analyze({
      instruction: "0.02 ZEC ödeyebilir miyim?",
      requesterId: "private-agent-id",
    });

    expect(intent).toMatchObject({ capability: Capability.CAN_AFFORD, source: "llm", amountZec: "0.02" });
    expect(requests[0]?.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer nvapi-test-only");
    expect(requests[0]?.body).not.toContain("private-agent-id");
    expect(intent).not.toHaveProperty("decision");
  });

  it("selects NVIDIA only when explicitly requested with an API key", () => {
    expect(createIntentAnalyzerFromEnv({ AI_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test" })).toMatchObject({
      provider: "nvidia",
      model: "meta/llama-3.1-8b-instruct",
    });
    expect(createIntentAnalyzerFromEnv({ AI_PROVIDER: "nvidia" })).toMatchObject({ provider: "deterministic" });
  });

  it("chooses the highest-risk known capability when NIM combines multiple capabilities", async () => {
    const provider = new NvidiaNimLLMProvider({
      apiKey: "nvapi-test-only",
      fetcher: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: [
              "```json",
              JSON.stringify({
                capability: "LIST_TRANSACTIONS, READ_EXACT_BALANCE",
                purpose: "Geniş cüzdan okuma erişimi",
                explanation: "Birden fazla hassas okuma yetkisi istendi.",
                recipient: null,
              }),
              "```",
              "A second intent follows.",
              "```json",
              JSON.stringify({
                capability: Capability.EXPORT_VIEWING_KEY,
                purpose: "Viewing key dışa aktarımı",
                explanation: "Kalıcı görüntüleme yetkisi istendi.",
                amountZec: 0.01,
                paymentId: null,
              }),
              "```",
            ].join("\n") } }],
          };
        },
      }),
    });

    await expect(provider.proposeIntent({ instruction: "Geniş cüzdan erişimi", requesterId: "agent" }))
      .resolves.toMatchObject({ capability: Capability.EXPORT_VIEWING_KEY, amountZec: "0.01" });
  });
});
