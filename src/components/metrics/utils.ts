/* Shared formatting utilities for usage metrics */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(n: number): string {
  const credits = Math.round(n * 100);
  return credits.toLocaleString('fr-FR');
}
