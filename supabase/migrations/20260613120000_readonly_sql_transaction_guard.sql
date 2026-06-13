-- Promote execute_readonly_sql's safety from statement-shape checks to a hard
-- capability boundary by forcing the executing transaction into read-only mode.
--
-- The prior version relied on leading-keyword regexes + the `SELECT ... FROM
-- (<sql>) t` subquery wrapper. Those catch the common cases but reason about
-- statement *shape*, not capability — e.g. a data-modifying CTE
-- (`WITH x AS (INSERT ...) SELECT ...`) starts with `WITH`, slipping past the
-- regex, and `EXPLAIN ANALYZE INSERT ...` actually executes the write.
--
-- `SET LOCAL transaction_read_only = on` makes Postgres itself reject ANY write
-- (INSERT/UPDATE/DELETE/DDL, writable CTEs, EXPLAIN ANALYZE of a write) with
-- `cannot execute ... in a read-only transaction`, regardless of phrasing. The
-- setting is transaction-scoped; since each PostgREST RPC runs in its own
-- transaction this is contained to the call. The existing keyword guards are
-- kept as defense-in-depth and to return friendlier error messages.

CREATE OR REPLACE FUNCTION public.execute_readonly_sql(sql text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  clean TEXT;
  inner_sql TEXT;
  normalized TEXT;
  explain_json JSON;
BEGIN
  -- Hard boundary: forbid all writes for the remainder of this transaction.
  -- Set as a GUC (not the SQL-standard SET TRANSACTION, which must precede any
  -- query) so it holds even though this runs mid-transaction under PostgREST.
  SET LOCAL transaction_read_only = on;

  -- Strip trailing semicolons / whitespace.
  clean := regexp_replace(trim(sql), ';+\s*$', '');
  normalized := lower(trim(clean));

  -- EXPLAIN path: re-issue with FORMAT JSON so we can capture a structured plan.
  IF normalized LIKE 'explain%' THEN
    inner_sql := regexp_replace(clean, '^\s*explain\s+(analyze\s+)?', '', 'i');
    -- Guard: the statement being explained must itself be read-only. (The
    -- read-only transaction also blocks EXPLAIN ANALYZE of a write; this just
    -- fails faster with a clearer message.)
    IF lower(trim(inner_sql)) ~ '^(insert|update|delete|drop|alter|create|truncate|grant|revoke)' THEN
      RAISE EXCEPTION 'Only read-only queries are permitted. Blocked keyword detected.';
    END IF;
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || inner_sql INTO explain_json;
    RETURN to_jsonb(explain_json);
  END IF;

  -- Safety check: block any mutating statements.
  IF normalized ~ '^(insert|update|delete|drop|alter|create|truncate|grant|revoke)' THEN
    RAISE EXCEPTION 'Only read-only queries are permitted. Blocked keyword detected.';
  END IF;

  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || clean || ') t'
  INTO result;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$function$;
