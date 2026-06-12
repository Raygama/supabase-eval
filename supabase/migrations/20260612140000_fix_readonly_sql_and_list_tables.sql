-- Harden execute_readonly_sql so it tolerates trailing semicolons and supports
-- EXPLAIN (which cannot be wrapped in a subquery). Still strictly read-only.
-- Also add list_tables_info(), the RPC the mcp-server's list_tables tool calls.
--
-- Without this, 3 of 5 MCP tools fail:
--   * get_schema    -> trailing ';' breaks the `SELECT jsonb_agg(...) FROM (<sql>) t` wrapper
--   * explain_query -> `EXPLAIN ANALYZE ...` cannot be used as a subquery
--   * list_tables   -> list_tables_info() did not exist

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
  -- Strip trailing semicolons / whitespace.
  clean := regexp_replace(trim(sql), ';+\s*$', '');
  normalized := lower(trim(clean));

  -- EXPLAIN path: re-issue with FORMAT JSON so we can capture a structured plan.
  IF normalized LIKE 'explain%' THEN
    inner_sql := regexp_replace(clean, '^\s*explain\s+(analyze\s+)?', '', 'i');
    -- Guard: the statement being explained must itself be read-only.
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

CREATE OR REPLACE FUNCTION public.list_tables_info()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'table_name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'table_name', c.table_name,
      'columns', jsonb_agg(
        jsonb_build_object(
          'column_name', c.column_name,
          'data_type', c.data_type,
          'is_nullable', c.is_nullable
        ) ORDER BY c.ordinal_position
      )
    ) AS t
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
    GROUP BY c.table_name
  ) sub;
$function$;
