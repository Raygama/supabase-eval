import 'dotenv/config';
import { supabase } from '../lib/supabase';
import { runAgent } from '../agent';
import { judgeResult } from './judge';
import { TEST_CASES, CATEGORIES, type TestCase } from './test-cases';
import { generateReport } from './report';

/** Orchestrates a full eval run: agent → judge → persist → summarize. */

const DIVIDER = '━'.repeat(38);

interface RowResult {
  test_case_id: string;
  category: string;
  passed: boolean;
  score: number;
  latency_ms: number;
  actual_tool_called: string | null;
}

function bar(rate: number, width = 12): string {
  const filled = Math.round(rate * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function runOne(tc: TestCase): Promise<RowResult> {
  const agent = await runAgent(tc.task);
  const judge = await judgeResult(
    tc.task,
    tc.expectedTool,
    agent.toolCalled,
    agent.finalAnswer,
    tc.expectRejection ?? false
  );

  const row = {
    run_id: RUN_ID,
    test_case_id: tc.id,
    category: tc.category,
    task: tc.task,
    expected_tool: tc.expectedTool,
    actual_tool_called: agent.toolCalled,
    // Full execution trace — surfaced per-case in the dashboard.
    tool_input: agent.toolInput,
    tool_output: agent.toolOutput,
    doc_chunks: agent.docChunks,
    agent_output: agent.finalAnswer,
    judge_score: judge.score,
    judge_reasoning: judge.reasoning,
    passed: judge.passed,
    latency_ms: agent.latency_ms,
  };

  const { error } = await supabase.from('eval_results').insert(row);
  if (error) console.warn(`  ⚠️  Failed to persist ${tc.id}: ${error.message}`);

  const icon = judge.passed ? '✅' : '❌';
  const toolLabel = tc.expectRejection
    ? agent.toolCalled
      ? `called ${agent.toolCalled} (should refuse)`
      : 'rejected correctly'
    : agent.toolCalled ?? 'no tool';
  console.log(`[${tc.id}] ${icon} ${judge.score}/5 — ${toolLabel} (${agent.latency_ms}ms)`);

  return {
    test_case_id: tc.id,
    category: tc.category,
    passed: judge.passed,
    score: judge.score,
    latency_ms: agent.latency_ms,
    actual_tool_called: agent.toolCalled,
  };
}

const RUN_ID = `eval_${Date.now()}`;

async function main() {
  console.log(`🚀 Starting eval run: ${RUN_ID}`);
  console.log(DIVIDER + '\n');

  const results: RowResult[] = [];
  for (const tc of TEST_CASES) {
    try {
      results.push(await runOne(tc));
    } catch (err) {
      console.error(`[${tc.id}] 💥 errored: ${err instanceof Error ? err.message : err}`);
      results.push({
        test_case_id: tc.id,
        category: tc.category,
        passed: false,
        score: 1,
        latency_ms: 0,
        actual_tool_called: null,
      });
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latency_ms, 0) / total);
  const avgScore = (results.reduce((s, r) => s + r.score, 0) / total).toFixed(2);

  console.log('\n' + DIVIDER);
  console.log(`📊 Results for ${RUN_ID}`);
  console.log(`  Total:    ${total} cases`);
  console.log(`  Passed:   ${passed} (${Math.round((passed / total) * 100)}%)`);
  console.log(`  Failed:   ${total - passed}`);
  console.log(`  Avg score: ${avgScore}/5\n`);
  console.log('  By category:');
  for (const cat of CATEGORIES) {
    const items = results.filter((r) => r.category === cat);
    const p = items.filter((r) => r.passed).length;
    const rate = p / items.length;
    console.log(
      `  ${cat.padEnd(16)} ${p}/${items.length}  ${bar(rate)} ${String(Math.round(rate * 100)).padStart(3)}%`
    );
  }
  console.log(`\n  Avg latency: ${avgLatency}ms`);
  console.log(DIVIDER);

  await generateReport(RUN_ID);
  console.log(`\n📝 Report written to reports/${RUN_ID}.md`);
}

main().catch((err) => {
  console.error('❌ eval run failed:', err);
  process.exit(1);
});
