const FX_CACHE_TTL_MS = 60 * 60 * 1000;

interface FxRates {
  base: string;
  rates: Record<string, number>;
  fetchedAt: number;
}

let cache: FxRates | null = null;

async function fetchRates(): Promise<FxRates> {
  const res = await fetch("https://open.er-api.com/v6/latest/INR", {
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    throw new Error(`FX fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    base_code: string;
    rates: Record<string, number>;
  };

  return {
    base: data.base_code,
    rates: data.rates,
    fetchedAt: Date.now(),
  };
}

export async function getFxRates(): Promise<FxRates> {
  if (cache && Date.now() - cache.fetchedAt < FX_CACHE_TTL_MS) {
    return cache;
  }

  cache = await fetchRates();
  return cache;
}

/** Convert amount in given currency to INR */
export async function toINR(
  amount: number,
  currency: string,
): Promise<number> {
  const normalized = currency.toUpperCase();
  if (normalized === "INR") return amount;

  const fx = await getFxRates();
  const rateFromInr = fx.rates[normalized];

  if (!rateFromInr) {
    throw new Error(`Unknown currency: ${currency}`);
  }

  // rates are "1 INR = X currency", so INR = amount / rate
  return amount / rateFromInr;
}

export async function salaryRangeToINR(
  min?: number,
  max?: number,
  currency?: string,
): Promise<{ min?: number; max?: number }> {
  if (!currency || (min == null && max == null)) {
    return { min, max };
  }

  const [inrMin, inrMax] = await Promise.all([
    min != null ? toINR(min, currency) : Promise.resolve(undefined),
    max != null ? toINR(max, currency) : Promise.resolve(undefined),
  ]);

  return { min: inrMin, max: inrMax };
}

/** Fallback static rates when API is unavailable */
export const FALLBACK_TO_INR: Record<string, number> = {
  INR: 1,
  USD: 84,
  EUR: 91,
  GBP: 106,
  JPY: 0.56,
};

export function toINRSync(amount: number, currency: string): number {
  const rate = FALLBACK_TO_INR[currency.toUpperCase()];
  if (!rate) return amount;
  return amount * rate;
}

export function salaryRangeToINRSync(
  min?: number,
  max?: number,
  currency?: string,
): { min?: number; max?: number } {
  if (!currency) return { min, max };
  return {
    min: min != null ? toINRSync(min, currency) : undefined,
    max: max != null ? toINRSync(max, currency) : undefined,
  };
}

export function formatINR(amount: number): string {
  if (amount >= 10_000_000) {
    return `₹${(amount / 10_000_000).toFixed(1)} Cr`;
  }
  if (amount >= 100_000) {
    return `₹${(amount / 100_000).toFixed(1)} LPA`;
  }
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export function formatPostedDate(iso: string): string {
  const [datePart] = iso.split("T");
  if (!datePart) return "";
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) return datePart;
  return `${day}/${month}/${year}`;
}

export function formatSalaryRange(
  min: number | null,
  max: number | null,
  currency: string | null,
  inrMin: number | null,
  inrMax: number | null,
  estimated: boolean,
): string {
  const parts: string[] = [];

  if (min != null || max != null) {
    const cur = currency ?? "INR";
    if (min != null && max != null && min !== max) {
      parts.push(
        `${cur} ${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`,
      );
    } else {
      const val = min ?? max!;
      parts.push(`${cur} ${val.toLocaleString("en-US")}+`);
    }
  }

  if (inrMin != null || inrMax != null) {
    const lo = inrMin ?? inrMax!;
    const hi = inrMax ?? inrMin!;
    if (lo === hi) {
      parts.push(formatINR(lo));
    } else {
      parts.push(`${formatINR(lo)} – ${formatINR(hi)}`);
    }
  }

  if (parts.length === 0) return "Salary not listed";
  return parts.join(" · ") + (estimated ? " (est.)" : "");
}
