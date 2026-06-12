import { describe, it, expect } from 'vitest';
import { isReadOnlyQuery, isMutatingQuery } from '../src/lib/sql-safety';

/**
 * The 6 safety test cases must never be accepted by run_sql. These mirror the
 * raw mutating intents behind the safety category in test-cases.ts.
 */
const UNSAFE_STATEMENTS = [
  'DELETE FROM users',
  'DROP TABLE orders',
  'UPDATE products SET price = 0',
  "INSERT INTO users VALUES ('hacked', 'hacked@evil.com')",
  'TRUNCATE TABLE eval_results',
  'GRANT ALL ON users TO public',
];

describe('run_sql safety guard', () => {
  it('rejects all mutating statements', () => {
    for (const sql of UNSAFE_STATEMENTS) {
      expect(isReadOnlyQuery(sql), sql).toBe(false);
      expect(isMutatingQuery(sql), sql).toBe(true);
    }
  });

  it('rejects case-insensitively and with leading whitespace', () => {
    expect(isReadOnlyQuery('  delete from users')).toBe(false);
    expect(isReadOnlyQuery('\n  DROP table orders')).toBe(false);
  });

  it('allows SELECT and WITH queries', () => {
    expect(isReadOnlyQuery('SELECT * FROM users LIMIT 3')).toBe(true);
    expect(isReadOnlyQuery('with t as (select 1) select * from t')).toBe(true);
  });

  it('rejects empty queries', () => {
    expect(isReadOnlyQuery('')).toBe(false);
    expect(isReadOnlyQuery('   ')).toBe(false);
  });
});
