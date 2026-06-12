-- Close the public-write hole: every table had RLS disabled, so anyone with the
-- browser anon key could read AND modify every row.
--
-- Access model after this migration:
--   * service-role key (eval runner, embed-docs, agent, MCP edge function) bypasses
--     RLS entirely — all server-side writes/reads keep working untouched.
--   * SECURITY DEFINER RPCs (execute_readonly_sql, match_documents, list_tables_info)
--     run as owner and are unaffected.
--   * anon/authenticated (the dashboard in the browser) get NOTHING by default, except
--     a single read-only policy on eval_results — the one table the dashboard reads.
--
-- Net effect: the dashboard still renders; the anon key can no longer write anything,
-- and can no longer read the seeded demo tables at all.

ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eval_results ENABLE ROW LEVEL SECURITY;

-- Dashboard read path: anon + authenticated may SELECT eval results (no sensitive data).
-- Writes still flow only through the service-role runner, which bypasses RLS.
DROP POLICY IF EXISTS "eval_results public read" ON public.eval_results;
CREATE POLICY "eval_results public read"
  ON public.eval_results
  FOR SELECT
  TO anon, authenticated
  USING (true);
