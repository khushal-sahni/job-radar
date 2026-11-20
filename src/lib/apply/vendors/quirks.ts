import type { ApplyVendor } from "../types";

/**
 * How one ATS family departs from a plain form. The generic ATS flow asks these instead of
 * checking vendor names, so a new quirk is one line here.
 */
export interface AtsQuirks {
  /** A spam check can email a one-time code that must be typed in before the submit counts. */
  emailsSecurityCode: boolean;
  /**
   * Submits by itself once the captcha passes, with a one-time token. Clicking Submit again
   * resends the token and the form answers "error verifying your application".
   */
  submitsAfterCaptcha: boolean;
  /** A closed posting redirects to the company's job list, dropping the job id from the URL. */
  closedDropsJobId: boolean;
}

const NONE: AtsQuirks = { emailsSecurityCode: false, submitsAfterCaptcha: false, closedDropsJobId: false };

const BY_VENDOR: Partial<Record<ApplyVendor, Partial<AtsQuirks>>> = {
  greenhouse: { emailsSecurityCode: true },
  lever: { submitsAfterCaptcha: true, closedDropsJobId: true },
  ashby: { closedDropsJobId: true },
};

/** Form hosts that give their family away even when the job was listed under another vendor. */
const BY_HOST: Array<[RegExp, ApplyVendor]> = [
  [/greenhouse\.io/i, "greenhouse"],
  [/jobs\.lever\.co/i, "lever"],
];

/** Quirks of the listed vendor plus those of the form actually on screen (an embed or redirect). */
export function atsQuirks(vendor: ApplyVendor, pageUrl?: string): AtsQuirks {
  const hosted = pageUrl ? BY_HOST.find(([re]) => re.test(pageUrl))?.[1] : undefined;
  const quirks = { ...NONE, ...BY_VENDOR[vendor] };
  if (hosted) {
    for (const [key, on] of Object.entries(BY_VENDOR[hosted] ?? {}) as Array<[keyof AtsQuirks, boolean]>) {
      if (on && key !== "closedDropsJobId") quirks[key] = true;
    }
  }
  return quirks;
}
