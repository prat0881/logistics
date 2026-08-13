import { z } from "zod";
import { CURRENCY_CODES } from "./reference";

export const fxRateCreateSchema = z.object({
  currency: z
    .enum(CURRENCY_CODES)
    .refine((c) => c !== "USD", {
      message: "USD is the base currency (rate ≡ 1) and is never stored",
    }),
  unitsPerUsd: z.number().positive(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
});
export type FxRateCreateInput = z.infer<typeof fxRateCreateSchema>;

export type FxRateDto = {
  id: string;
  currency: string;
  unitsPerUsd: number;
  effectiveFrom: string;
  note: string | null;
  createdById: string | null;
  createdAt: string;
};

/** Normalise a native amount to USD. USD passes through; a foreign currency needs a rate. */
export function toUsd(
  amount: number,
  currency: string,
  rate: Pick<FxRateDto, "unitsPerUsd"> | null,
): number | null {
  if (currency === "USD") return amount;
  if (!rate) return null;
  return Math.round((amount / rate.unitsPerUsd) * 100) / 100;
}

/** Latest (max effectiveFrom) rate per currency. */
export function latestRateByCurrency(rates: FxRateDto[]): Map<string, FxRateDto> {
  const m = new Map<string, FxRateDto>();
  for (const r of rates) {
    const cur = m.get(r.currency);
    if (!cur || r.effectiveFrom > cur.effectiveFrom) m.set(r.currency, r);
  }
  return m;
}
