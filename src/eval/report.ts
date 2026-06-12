import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { supabase } from '../lib/supabase';
import { CATEGORIES } from './test-cases';

/** Generates a markdown report for an eval run from the eval_results table. */

interface EvalRow {
  run_id: string;
  test_case_id: string;
  category: string | null;
  task: string;
  expected_tool: string | null;
  actual_tool_called: string | null;
  agent_output: string | null;
  judge_score: number | null;
  judge_reasoning: string | null;
  passed: boolean | null;
  latency_ms: number | null;
  created_at: string;
}

const REPORTS_DIR = join(process.cwd(), 'reports');

async function latestRunId(): Promise<string | null> {
  const { data } = await supabase
    .from('eval_results')
    .select('run_id, created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0]?.run_id ?? null;
}

/** All distinct run_ids with their pass rate, oldest first (for trend data). */
async function runTrend(): Promise<Array<{ run_id: string; passRate: number; n: number }>> {
  const { data } = await supabase
    .from('eval_results')
    .select('run_id, passed, created_at')
    .order('created_at', { ascending: true });
  if (!data) return [];
  const byRun = new Map<string, { pass: number; n: number; firstSeen: number }>();
  for (const r of data as Array<{ run_id: string; passed: boolean | null; created_at: string }>) {
    const e = byRun.get(r.run_id) ?? { pass: 0, n: 0, firstSeen: new Date(r.created_at).getTime() };
    e.n += 1;
    if (r.passed) e.pass += 1;
    byRun.set(r.run_id, e);
  }
  return [...byRun.entries()].map(([run_id, e]) => ({
    run_id,
    passRate: e.pass / e.n,
    n: e.n,
  }));
}

export async function generateReport(runId?: string): Promise<string> {
  const targetRun = runId ?? (await latestRunId());
  if (!targetRun) throw new Error('No eval runs found in eval_results');

  const { data, error } = await supabase
    .from('eval_results')
    .select('*')
    .eq('run_id', targetRun)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as EvalRow[];
  if (rows.length === 0) throw new Error(`No rows for run ${targetRun}`);

  const total = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const avgScore = (rows.reduce((s, r) => s + (r.judge_score ?? 0), 0) / total).toFixed(2);
  const avgLatency = Math.round(rows.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / total);

  const lines: string[] = [];
  lines.push(`# Eval Report — \`${targetRun}\``);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total cases | ${total} |`);
  lines.push(`| Passed | ${passed} (${Math.round((passed / total) * 100)}%) |`);
  lines.push(`| Failed | ${total - passed} |`);
  lines.push(`| Avg score | ${avgScore} / 5 |`);
  lines.push(`| Avg latency | ${avgLatency} ms |`);
  lines.push('');

  lines.push('## By category');
  lines.push('');
  lines.push('| Category | Passed | Pass rate | Avg score |');
  lines.push('|---|---|---|---|');
  for (const cat of CATEGORIES) {
    const items = rows.filter((r) => r.category === cat);
    if (items.length === 0) continue;
    const p = items.filter((r) => r.passed).length;
    const a = (items.reduce((s, r) => s + (r.judge_score ?? 0), 0) / items.length).toFixed(2);
    lines.push(`| ${cat} | ${p}/${items.length} | ${Math.round((p / items.length) * 100)}% | ${a} |`);
  }
  lines.push('');

  const failures = rows.filter((r) => !r.passed);
  lines.push('## Failed cases');
  lines.push('');
  if (failures.length === 0) {
    lines.push('_None — all cases passed._');
  } else {
    for (const f of failures) {
      lines.push(`### \`${f.test_case_id}\` (${f.category}) — score ${f.judge_score}/5`);
      lines.push('');
      lines.push(`- **Task:** ${f.task}`);
      lines.push(`- **Expected tool:** ${f.expected_tool ?? '(refuse)'}`);
      lines.push(`- **Actual tool:** ${f.actual_tool_called ?? '(none)'}`);
      lines.push(`- **Judge reasoning:** ${f.judge_reasoning ?? '(none)'}`);
      lines.push('');
    }
  }

  const trend = await runTrend();
  if (trend.length > 1) {
    lines.push('## Trend across runs');
    lines.push('');
    lines.push('| Run | Cases | Pass rate |');
    lines.push('|---|---|---|');
    for (const t of trend) {
      lines.push(`| \`${t.run_id}\` | ${t.n} | ${Math.round(t.passRate * 100)}% |`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  await mkdir(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${targetRun}.md`);
  await writeFile(path, content, 'utf8');
  return path;
}

// CLI: `npm run eval:report -- [run_id]`
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const runId = process.argv[2];
  generateReport(runId)
    .then((p) => console.log(`📝 Report written to ${p}`))
    .catch((err) => {
      console.error('❌ report failed:', err);
      process.exit(1);
    });
}
