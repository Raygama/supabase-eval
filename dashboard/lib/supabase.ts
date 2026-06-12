import { createClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client using the anon (public) key, read-only by intent.
 * The eval_results table holds no sensitive data, so public read is acceptable.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase =
  url && anonKey ? createClient(url, anonKey) : null;

/** A doc chunk returned by semantic_search, with its similarity score. */
export interface DocChunk {
  title?: string;
  content?: string;
  similarity?: number;
  source?: string;
}

export interface EvalRow {
  id: string;
  run_id: string;
  test_case_id: string;
  category: string | null;
  task: string;
  expected_tool: string | null;
  actual_tool_called: string | null;
  // Execution trace (added by the trace-columns migration). Null on older rows.
  tool_input: Record<string, unknown> | null;
  tool_output: unknown;
  doc_chunks: DocChunk[] | null;
  agent_output: string | null;
  judge_score: number | null;
  judge_reasoning: string | null;
  passed: boolean | null;
  latency_ms: number | null;
  created_at: string;
}
