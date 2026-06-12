'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { supabase, type EvalRow } from '../lib/supabase';

const CATEGORY_ORDER = [
  'sql-generation',
  'schema-lookup',
  'doc-retrieval',
  'performance',
  'safety',
];

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="text-sm text-white/50">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-white">{value}</div>
      {sub && <div className="mt-1 text-xs text-white/40">{sub}</div>}
    </div>
  );
}

export default function EvalDashboard() {
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [allRows, setAllRows] = useState<EvalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function load() {
      if (!supabase) {
        setError('Supabase env vars are not configured (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY).');
        setLoading(false);
        return;
      }
      const { data: all, error: allErr } = await supabase
        .from('eval_results')
        .select('*')
        .order('created_at', { ascending: false });
      if (allErr) {
        setError(allErr.message);
        setLoading(false);
        return;
      }
      const rowsAll = (all ?? []) as EvalRow[];
      setAllRows(rowsAll);
      const latestRunId = rowsAll[0]?.run_id;
      setRows(rowsAll.filter((r) => r.run_id === latestRunId));
      setLoading(false);
    }
    load();
  }, []);

  const stats = useMemo(() => {
    const total = rows.length;
    const passed = rows.filter((r) => r.passed).length;
    const avgScore = total ? rows.reduce((s, r) => s + (r.judge_score ?? 0), 0) / total : 0;
    const avgLatency = total ? rows.reduce((s, r) => s + (r.latency_ms ?? 0), 0) / total : 0;
    return { total, passed, avgScore, avgLatency };
  }, [rows]);

  const categoryData = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => {
      const items = rows.filter((r) => r.category === cat);
      const passRate = items.length
        ? Math.round((items.filter((r) => r.passed).length / items.length) * 100)
        : 0;
      return { category: cat, passRate };
    });
  }, [rows]);

  const runs = useMemo(() => {
    const map = new Map<string, EvalRow[]>();
    for (const r of allRows) {
      const arr = map.get(r.run_id) ?? [];
      arr.push(r);
      map.set(r.run_id, arr);
    }
    return [...map.entries()].map(([run_id, items]) => ({
      run_id,
      items,
      passed: items.filter((i) => i.passed).length,
      total: items.length,
      when: items[0]?.created_at,
    }));
  }, [allRows]);

  const latestRunId = rows[0]?.run_id;

  if (loading) return <div className="text-white/60">Loading eval results…</div>;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">supabase-eval dashboard</h1>
          <p className="text-sm text-white/50">
            Latest run: <span className="text-brand">{latestRunId ?? '—'}</span>
            {rows[0]?.created_at && (
              <> · {new Date(rows[0].created_at).toLocaleString()}</>
            )}
          </p>
        </div>
        <a
          className="text-sm text-brand hover:underline"
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
        >
          source ↗
        </a>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/60">
          No eval results yet. Run <code className="text-brand">npm run eval:run</code> to populate.
        </div>
      )}

      {rows.length > 0 && (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard label="Total cases" value={String(stats.total)} />
            <StatCard
              label="Pass rate"
              value={`${Math.round((stats.passed / stats.total) * 100)}%`}
              sub={`${stats.passed}/${stats.total} passed`}
            />
            <StatCard label="Avg score" value={`${stats.avgScore.toFixed(2)}/5`} />
            <StatCard label="Avg latency" value={`${Math.round(stats.avgLatency)}ms`} />
          </section>

          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-4 text-sm font-semibold text-white/70">Pass rate by category</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff15" />
                  <XAxis dataKey="category" stroke="#ffffff80" fontSize={12} />
                  <YAxis domain={[0, 100]} stroke="#ffffff80" fontSize={12} unit="%" />
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #ffffff20' }}
                    formatter={(v) => [`${v}%`, 'pass rate']}
                  />
                  <Bar dataKey="passRate" radius={[4, 4, 0, 0]}>
                    {categoryData.map((d) => (
                      <Cell key={d.category} fill={d.passRate >= 80 ? '#3ecf8e' : '#f59e0b'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="mb-4 text-sm font-semibold text-white/70">Recent runs</h2>
            <div className="space-y-2">
              {runs.map((run) => {
                const open = expanded.has(run.run_id);
                return (
                  <div key={run.run_id} className="rounded-lg border border-white/10">
                    <button
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                      onClick={() => {
                        const next = new Set(expanded);
                        next.has(run.run_id) ? next.delete(run.run_id) : next.add(run.run_id);
                        setExpanded(next);
                      }}
                    >
                      <span className="font-mono text-sm text-white/80">{run.run_id}</span>
                      <span className="text-sm text-white/50">
                        {run.passed}/{run.total} ·{' '}
                        {Math.round((run.passed / run.total) * 100)}% · {open ? '▲' : '▼'}
                      </span>
                    </button>
                    {open && (
                      <div className="overflow-x-auto border-t border-white/10">
                        <table className="w-full text-left text-sm">
                          <thead className="text-white/40">
                            <tr>
                              <th className="px-4 py-2">Case</th>
                              <th className="px-4 py-2">Category</th>
                              <th className="px-4 py-2">Tool</th>
                              <th className="px-4 py-2">Score</th>
                              <th className="px-4 py-2">Latency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.items.map((i) => (
                              <tr key={i.id} className="border-t border-white/5">
                                <td className="px-4 py-2 font-mono text-white/80">{i.test_case_id}</td>
                                <td className="px-4 py-2 text-white/60">{i.category}</td>
                                <td className="px-4 py-2 text-white/60">
                                  {i.actual_tool_called ?? '—'}
                                </td>
                                <td className="px-4 py-2">
                                  <span className={i.passed ? 'text-brand' : 'text-amber-400'}>
                                    {i.judge_score}/5
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-white/60">{i.latency_ms}ms</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
