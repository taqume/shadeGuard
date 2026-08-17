const ZATOSHI_PER_ZEC = 100_000_000;
const MAX_ZEC = 21_000_000;

export function parseZec(value: string | number): number {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,8}))?$/.exec(normalized);

  if (!match) {
    throw new Error("Amount must be a non-negative decimal ZEC value with at most 8 decimals");
  }

  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(8, "0");
  if (!Number.isSafeInteger(whole) || whole > MAX_ZEC) {
    throw new Error("Amount is outside the valid ZEC range");
  }

  const zatoshi = whole * ZATOSHI_PER_ZEC + Number(fraction || "0");
  if (!Number.isSafeInteger(zatoshi) || zatoshi > MAX_ZEC * ZATOSHI_PER_ZEC) {
    throw new Error("Amount is outside the valid ZEC range");
  }

  return zatoshi;
}

export function formatZec(zatoshi: number): string {
  if (!Number.isSafeInteger(zatoshi) || zatoshi < 0) {
    throw new Error("Zatoshi amount must be a non-negative safe integer");
  }

  const whole = Math.floor(zatoshi / ZATOSHI_PER_ZEC);
  const fraction = String(zatoshi % ZATOSHI_PER_ZEC).padStart(8, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : String(whole);
}

export { ZATOSHI_PER_ZEC };
