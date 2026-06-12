/**
 * Client-side mirror of the safety rule enforced by the MCP server's `run_sql`
 * tool AND the `execute_readonly_sql` DB function. A query is read-only only if,
 * after normalization, it starts with SELECT or WITH.
 *
 * This is a defense-in-depth convenience for callers; the authoritative checks
 * live in the Edge Function and the database function.
 */
export function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;
  return normalized.startsWith('select') || normalized.startsWith('with');
}

const MUTATING = /^(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/;

/** True if the statement is an explicit mutating/DDL statement. */
export function isMutatingQuery(query: string): boolean {
  return MUTATING.test(query.trim().toLowerCase().replace(/\s+/g, ' '));
}
