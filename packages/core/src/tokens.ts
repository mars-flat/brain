/**
 * Deterministic, dependency-free token estimate: ceil(chars / 4). The tier
 * sizes in §5.5 are approximations by design; what the budget invariant
 * needs is a consistent, monotone measure, not a vendor tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
