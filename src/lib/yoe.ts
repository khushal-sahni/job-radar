/** Parse minimum/max years of experience required from job text */
export function parseRequiredYears(text: string): {
  min?: number;
  max?: number;
} {
  const haystack = text.toLowerCase();
  let min: number | undefined;
  let max: number | undefined;

  const rangeMatch = haystack.match(
    /(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:\+?\s*)?years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)?/i,
  );
  if (rangeMatch) {
    const lo = Number(rangeMatch[1]);
    const hi = Number(rangeMatch[2]);
    if (lo <= 30 && hi <= 30) {
      return { min: lo, max: hi };
    }
  }

  const patterns = [
    /(?:minimum|min\.?|at least|requires?)\s*(?:of\s+)?(\d+)\s*(?:\+?\s*)?years?/gi,
    /(\d+)\s*\+\s*years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)?/gi,
    /(\d+)\s+years?\s*(?:of\s+)?(?:professional\s+)?(?:work\s+)?(?:experience|exp)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of haystack.matchAll(pattern)) {
      const years = Number(match[1]);
      if (years >= 0 && years <= 30) {
        min = min == null ? years : Math.max(min, years);
      }
    }
  }

  return { min, max };
}

export function isEligibleByYears(
  requiredMin: number | null | undefined,
  userYears: number,
): boolean {
  if (requiredMin == null) return true;
  return requiredMin <= userYears;
}

export function formatRequiredYears(
  min: number | null | undefined,
  max: number | null | undefined,
): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) {
    return `${min}–${max} yrs`;
  }
  const val = min ?? max!;
  return `${val}+ yrs`;
}
