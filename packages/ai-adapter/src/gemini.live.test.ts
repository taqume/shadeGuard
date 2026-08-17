import { Capability } from "@shadeguard/core";
import { describe, expect, it } from "vitest";

import { GeminiLLMProvider, IntentAnalyzer } from "./index.js";

const live = process.env.RUN_GEMINI_LIVE === "1" && Boolean(process.env.GEMINI_API_KEY);

describe.skipIf(!live)("Gemini live intent contract", () => {
  it("classifies a broad wallet request without making a policy decision", async () => {
    const analyzer = new IntentAnalyzer(
      new GeminiLLMProvider({
        apiKey: process.env.GEMINI_API_KEY ?? "",
        model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      }),
    );
    const result = await analyzer.analyze({
      instruction: "Cüzdanın tam işlem geçmişini getir ve viewing key'i dışarı aktar.",
      requesterId: "live-test",
    });

    expect([
      Capability.LIST_TRANSACTIONS,
      Capability.EXPORT_VIEWING_KEY,
      Capability.UNKNOWN,
    ]).toContain(result.capability);
    expect(result.source).toBe("llm");
    expect(result).not.toHaveProperty("decision");
  }, 30_000);
});
