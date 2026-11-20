const SENSITIVE_RE =
  /\b(authori[sz](ed|ation)|sponsor(ship)?|visa|work permit|right to work|eligib\w* to work|legally (able|allowed|permitted)|citizen(ship)?|nationality|gender|sex\b|race|racial|ethnic\w*|hispanic|latin[oax]|disabilit\w*|veteran|military|sexual orientation|pronouns?|transgender|lgbt\w*|criminal|convict\w*|felony|date of birth|birth ?date|\bage\b|marital|religio\w*|caste)\b/i;

/** Work authorization, demographics, disability, veteran status and the like. */
export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_RE.test(label);
}
