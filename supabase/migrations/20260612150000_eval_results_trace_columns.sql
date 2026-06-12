-- Add execution-trace columns to eval_results so the dashboard can show the full
-- chain for any test case: the tool input the agent constructed (e.g. the exact
-- SQL), the raw MCP response it got back, and the doc chunks (with similarity
-- scores) the RAG pre-fetch pulled in. judge_reasoning already exists.
--
-- All JSONB and nullable so older rows (written before this migration) stay valid.

ALTER TABLE public.eval_results
  ADD COLUMN IF NOT EXISTS tool_input  jsonb,
  ADD COLUMN IF NOT EXISTS tool_output jsonb,
  ADD COLUMN IF NOT EXISTS doc_chunks  jsonb;
