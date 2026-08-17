import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

interface SpendReservation {
  readonly day: string;
  readonly requestId: string;
  readonly amountZatoshi: number;
}

export interface SpendLedger {
  spentOn(day: string): Promise<number>;
  reserve(day: string, requestId: string, amountZatoshi: number): Promise<boolean>;
}

function reservationKey(day: string, requestId: string): string {
  return `${day}:${requestId}`;
}

function validateReservation(value: unknown): SpendReservation {
  if (!value || typeof value !== "object") throw new Error("Spend ledger entry is not an object");
  const candidate = value as Partial<SpendReservation>;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate.day ?? "")) throw new Error("Spend ledger day is invalid");
  if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0) {
    throw new Error("Spend ledger request ID is invalid");
  }
  if (!Number.isSafeInteger(candidate.amountZatoshi) || (candidate.amountZatoshi ?? 0) <= 0) {
    throw new Error("Spend ledger amount is invalid");
  }
  return candidate as SpendReservation;
}

export class MemorySpendLedger implements SpendLedger {
  protected readonly reservations = new Map<string, SpendReservation>();

  public async spentOn(day: string): Promise<number> {
    return [...this.reservations.values()]
      .filter((reservation) => reservation.day === day)
      .reduce((total, reservation) => total + reservation.amountZatoshi, 0);
  }

  public async reserve(day: string, requestId: string, amountZatoshi: number): Promise<boolean> {
    const reservation = validateReservation({ day, requestId, amountZatoshi });
    const key = reservationKey(day, requestId);
    const existing = this.reservations.get(key);
    if (existing) {
      if (existing.amountZatoshi !== amountZatoshi) throw new Error("Spend reservation conflicts with an existing request");
      return false;
    }
    this.reservations.set(key, reservation);
    return true;
  }
}

export class JsonlSpendLedger extends MemorySpendLedger {
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {
    super();
  }

  public override async spentOn(day: string): Promise<number> {
    await this.load();
    return super.spentOn(day);
  }

  public override async reserve(day: string, requestId: string, amountZatoshi: number): Promise<boolean> {
    await this.load();
    const reservation = validateReservation({ day, requestId, amountZatoshi });
    const key = reservationKey(day, requestId);
    const existing = this.reservations.get(key);
    if (existing) {
      if (existing.amountZatoshi !== amountZatoshi) throw new Error("Spend reservation conflicts with an existing request");
      return false;
    }

    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(reservation)}\n`, { encoding: "utf8", mode: 0o600 });
      this.reservations.set(key, reservation);
    });
    await this.writeQueue;
    return true;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    for (const line of content.split("\n").filter(Boolean)) {
      const reservation = validateReservation(JSON.parse(line) as unknown);
      const key = reservationKey(reservation.day, reservation.requestId);
      const existing = this.reservations.get(key);
      if (existing && existing.amountZatoshi !== reservation.amountZatoshi) {
        throw new Error("Spend ledger contains a conflicting duplicate request");
      }
      this.reservations.set(key, reservation);
    }
    this.loaded = true;
  }
}
