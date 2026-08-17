import { Capability } from "@shadeguard/core";
import { describe, expect, it } from "vitest";

import { IntentAnalyzer, NvidiaNimLLMProvider } from "./index.js";

const live = process.env.RUN_NVIDIA_LIVE === "1" && Boolean(process.env.NVIDIA_API_KEY);

describe.skipIf(!live)("NVIDIA NIM live intent contract", () => {
  it("classifies a wallet request without making a policy decision", async () => {
    const analyzer = new IntentAnalyzer(
      new NvidiaNimLLMProvider({
        apiKey: process.env.NVIDIA_API_KEY ?? "",
        model: process.env.NVIDIA_MODEL ?? "meta/llama-3.1-8b-instruct",
      }),
    );
    const result = await analyzer.analyze({
      instruction: "0.01 ZEC ödemesini cüzdanın tam bakiyesini açıklamadan karşılayabilir miyim?",
      requesterId: "live-test",
    });

    expect([Capability.CAN_AFFORD, Capability.READ_EXACT_BALANCE, Capability.UNKNOWN]).toContain(result.capability);
    expect(result.source).toBe("llm");
    expect(result).not.toHaveProperty("decision");
  }, 30_000);
});
