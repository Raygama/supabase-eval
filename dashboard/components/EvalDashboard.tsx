'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase, type DocChunk, type EvalRow } from '../lib/supabase';

const CATEGORY_ORDER = [
  'sql-generation',
  'schema-lookup',
  'doc-retrieval',
  'performance',
  'safety',
];

/* ── primitives ─────────────────────────────────────────────────────── */

// Telemetry wordmark — three signal bars, ties the brand to the instrument motif.
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2" y="11" width="4" height="9" rx="1.2" fill="var(--brand-dim)" />
      <rect x="9" y="6" width="4" height="14" rx="1.2" fill="var(--brand)" />
      <rect x="16" y="2" width="4" height="18" rx="1.2" fill="var(--brand)" opacity="0.55" />
    </svg>
  );
}

function tone(rate: number) {
  if (rate >= 80) return 'var(--brand)';
  if (rate >= 50) return 'var(--warn)';
  return 'var(--danger)';
}

// Section label rendered as an instrument rule — small caps, green tick, hairline.
function Rule({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <span className="h-3 w-[3px] rounded-full bg-brand" />
      <h2 className="mono text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
        {children}
      </h2>
      <span className="h-px flex-1 bg-line" />
      {aside && <span className="mono text-[11px] tracking-wider text-faint">{aside}</span>}
    </div>
  );
}

// Hand-built trend sparkline — the memorable anchor. Pass-rate across runs, live endpoint.
function Sparkline({ series }: { series: number[] }) {
  const W = 600;
  const H = 132;
  const pad = 6;
  if (series.length === 0) return null;

  const max = 100;
  const min = 0;
  const n = series.length;
  const x = (i: number) =>
    n === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (n - 1);
  const y = (v: number) =>
    H - pad - ((v - min) / (max - min)) * (H - pad * 2);

  const pts = series.map((v, i) => [x(i), y(v)] as const);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[n - 1][0].toFixed(1)} ${H - pad} L${pts[0][0].toFixed(1)} ${H - pad} Z`;
  const [lx, ly] = pts[n - 1];
  const len = 900; // generous; over-shoots actual path length so the draw covers it

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-[132px] w-full"
      role="img"
      aria-label={`Pass-rate trend across ${n} runs`}
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((g) => (
        <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeWidth={1} />
      ))}
      <path d={area} fill="url(#spark-fill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--brand)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="spark-line"
        style={{ '--len': len, strokeDasharray: len } as React.CSSProperties}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r={5.5} fill="var(--brand)" opacity={0.25} />
      <circle cx={lx} cy={ly} r={3} fill="var(--brand)" stroke="var(--bg)" strokeWidth={1.5} />
    </svg>
  );
}

function DeltaChip({ delta }: { delta: number | null }) {
  if (delta === null) {
    return <span className="mono text-[11px] tracking-wide text-faint">first run</span>;
  }
  const up = delta >= 0;
  const color = up ? 'var(--brand)' : 'var(--danger)';
  return (
    <span
      className="mono inline-flex items-center gap-1 rounded-md border px-2 py-[3px] text-[11px] font-semibold"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {Math.abs(delta)}pt vs prev
    </span>
  );
}

function StatTile({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel/60 px-4 py-4">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-faint">{label}</div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="mono text-2xl font-semibold tracking-tight text-ink">{value}</span>
        {unit && <span className="mono text-sm text-muted">{unit}</span>}
      </div>
      {sub && <div className="mono mt-1 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

/* ── case trace ─────────────────────────────────────────────────────── */

// Pretty-print any payload (string passthrough, otherwise indented JSON).
function payloadText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Monospace scroll box for SQL / JSON payloads.
function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg/50 px-3 py-2 text-[11.5px] leading-relaxed text-ink">
      {text}
    </pre>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="mono text-[12px] italic text-faint">{children}</p>;
}

// One numbered step in the agent trace, threaded onto a vertical rail.
function TraceStep({
  n,
  label,
  aside,
  children,
}: {
  n: number;
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative pl-9">
      <span className="absolute left-0 top-0 z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line bg-panel-2">
        <span className="mono text-[10px] font-semibold text-muted">{n}</span>
      </span>
      <div className="mb-2 flex items-center gap-2">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-faint">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

// A single retrieved doc chunk: title, similarity score + bar, content snippet.
function ChunkCard({ chunk, rank }: { chunk: DocChunk; rank: number }) {
  const sim = typeof chunk.similarity === 'number' ? chunk.similarity : null;
  const pct = sim === null ? 0 : Math.max(0, Math.min(100, sim * 100));
  return (
    <div className="rounded-md border border-line bg-panel-2/50 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] text-faint">#{rank}</span>
        <span className="mono flex-1 truncate text-[12px] text-ink">{chunk.title ?? '(untitled chunk)'}</span>
        {sim !== null && (
          <span className="mono text-[11px] tabular-nums" style={{ color: tone(pct) }}>
            {sim.toFixed(3)}
          </span>
        )}
      </div>
      {sim !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel ring-1 ring-inset ring-line">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone(pct) }} />
        </div>
      )}
      {chunk.content && (
        <p className="mono mt-2 line-clamp-3 text-[11px] leading-relaxed text-muted">{chunk.content}</p>
      )}
    </div>
  );
}

// The full chain for one test case: task → retrieval → tool+input → MCP → answer → judge.
function CaseTrace({ row }: { row: EvalRow }) {
  const chunks = row.doc_chunks ?? [];
  const toolInput = row.tool_input ?? null;
  const sql =
    toolInput && typeof toolInput.query === 'string' ? (toolInput.query as string) : null;
  const score = row.judge_score;
  const scoreColor = row.passed ? 'var(--brand)' : 'var(--warn)';

  return (
    <div className="relative space-y-6 px-5 py-5">
      {/* vertical rail behind the step numbers */}
      <span className="absolute bottom-6 left-[10px] top-6 w-px bg-line" aria-hidden />

      <TraceStep n={1} label="task">
        <p className="text-[13px] leading-relaxed text-ink">{row.task}</p>
      </TraceStep>

      <TraceStep
        n={2}
        label="doc context retrieved"
        aside={
          <span className="mono text-[10px] text-faint">
            {chunks.length} chunk{chunks.length === 1 ? '' : 's'} · semantic_search
          </span>
        }
      >
        {chunks.length === 0 ? (
          <Empty>No documentation retrieved for this task.</Empty>
        ) : (
          <div className="space-y-2">
            {chunks.map((c, i) => (
              <ChunkCard key={i} chunk={c} rank={i + 1} />
            ))}
          </div>
        )}
      </TraceStep>

      <TraceStep
        n={3}
        label="tool chosen + input"
        aside={
          row.actual_tool_called ? (
            <span className="mono rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[10px] text-brand">
              {row.actual_tool_called}
            </span>
          ) : (
            <span className="mono text-[10px] text-faint">no tool</span>
          )
        }
      >
        {!row.actual_tool_called ? (
          <Empty>No tool called — refusal or directly-answered question.</Empty>
        ) : sql ? (
          <CodeBlock text={sql} />
        ) : toolInput && Object.keys(toolInput).length > 0 ? (
          <CodeBlock text={payloadText(toolInput)} />
        ) : (
          <Empty>Tool took no arguments.</Empty>
        )}
      </TraceStep>

      <TraceStep n={4} label="mcp response">
        {row.tool_output == null ? (
          <Empty>No MCP response recorded.</Empty>
        ) : (
          <CodeBlock text={payloadText(row.tool_output)} />
        )}
      </TraceStep>

      <TraceStep n={5} label="agent final answer">
        {row.agent_output ? (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{row.agent_output}</p>
        ) : (
          <Empty>(no answer)</Empty>
        )}
      </TraceStep>

      <TraceStep
        n={6}
        label="judge verdict"
        aside={
          <span className="mono flex items-center gap-1.5 text-[10px]">
            <span style={{ color: scoreColor }}>{score ?? '—'}/5</span>
            <span className="text-faint">·</span>
            <span style={{ color: scoreColor }}>{row.passed ? 'PASS' : 'FAIL'}</span>
          </span>
        }
      >
        {row.judge_reasoning ? (
          <div
            className="rounded-md border-l-2 px-3 py-2"
            style={{
              borderColor: scoreColor,
              background: `color-mix(in srgb, ${scoreColor} 7%, transparent)`,
            }}
          >
            <p className="text-[12.5px] leading-relaxed text-muted">{row.judge_reasoning}</p>
          </div>
        ) : (
          <Empty>No judge reasoning recorded.</Empty>
        )}
      </TraceStep>
    </div>
  );
}

/* ── dashboard ──────────────────────────────────────────────────────── */

export default function EvalDashboard() {
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [allRows, setAllRows] = useState<EvalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());

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
    return { total, passed, avgScore, avgLatency, passRate: total ? Math.round((passed / total) * 100) : 0 };
  }, [rows]);

  const categoryData = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => {
      const items = rows.filter((r) => r.category === cat);
      const passRate = items.length
        ? Math.round((items.filter((r) => r.passed).length / items.length) * 100)
        : 0;
      return { category: cat, passRate, passed: items.filter((r) => r.passed).length, total: items.length };
    }).filter((c) => c.total > 0);
  }, [rows]);

  // Runs, newest-first (allRows is desc by created_at).
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
      rate: items.length ? Math.round((items.filter((i) => i.passed).length / items.length) * 100) : 0,
      when: items[0]?.created_at,
    }));
  }, [allRows]);

  // Pass-rate series in chronological order for the trend line.
  const trend = useMemo(() => [...runs].reverse().map((r) => r.rate), [runs]);
  const delta = useMemo(() => {
    if (runs.length < 2) return null;
    return runs[0].rate - runs[1].rate;
  }, [runs]);

  const latest = rows[0];

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-panel" />
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="h-56 animate-pulse rounded-xl bg-panel lg:col-span-7" />
          <div className="h-56 animate-pulse rounded-xl bg-panel lg:col-span-5" />
        </div>
        <div className="h-40 animate-pulse rounded-xl bg-panel" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Header band */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div className="flex items-center gap-3">
          <Mark />
          <div>
            <h1 className="mono text-lg font-semibold tracking-tight text-ink">supabase-eval</h1>
            <p className="mono text-[11px] uppercase tracking-[0.22em] text-faint">
              agent evaluation telemetry
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className="live-dot h-2 w-2 rounded-full bg-brand" />
            <span className="mono text-[11px] tracking-wide text-muted">
              {latest?.run_id ? (
                <>
                  run <span className="text-ink">{latest.run_id}</span>
                  {latest.created_at && (
                    <span className="text-faint"> · {new Date(latest.created_at).toLocaleString()}</span>
                  )}
                </>
              ) : (
                'idle'
              )}
            </span>
          </div>
          <a
            className="mono text-[11px] tracking-wide text-muted transition-colors hover:text-brand"
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
        </div>
      </header>

      {error && (
        <div
          className="rounded-lg border px-4 py-3"
          style={{
            borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)',
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
          }}
        >
          <span className="mono text-sm" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="rounded-lg border border-line bg-panel/60 px-4 py-4">
          <span className="mono text-sm text-muted">
            No eval results yet. Run <span className="text-brand">npm run eval:run</span> to populate.
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Asymmetric hero: feature pass-rate panel + trend, stacked tiles right */}
          <section className="rise grid gap-4 lg:grid-cols-12">
            <div className="relative overflow-hidden rounded-xl border border-line-strong bg-panel lg:col-span-7">
              <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: tone(stats.passRate) }} />
              <div className="flex items-start justify-between px-6 pt-6">
                <div>
                  <div className="mono text-[10px] uppercase tracking-[0.2em] text-faint">pass rate · latest run</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="mono text-5xl font-bold tracking-tight" style={{ color: tone(stats.passRate) }}>
                      {stats.passRate}
                    </span>
                    <span className="mono text-2xl text-muted">%</span>
                  </div>
                  <div className="mono mt-1 text-[12px] text-muted">
                    {stats.passed}/{stats.total} cases passed
                  </div>
                </div>
                <div className="pt-1"><DeltaChip delta={delta} /></div>
              </div>
              <div className="mt-3 px-2 pb-2">
                <Sparkline series={trend} />
              </div>
              <div className="flex items-center justify-between border-t border-line px-6 py-2">
                <span className="mono text-[10px] uppercase tracking-[0.18em] text-faint">trend · {trend.length} runs</span>
                <span className="mono text-[10px] tracking-wide text-faint">0—100%</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 lg:col-span-5 lg:grid-cols-1">
              <StatTile label="total cases" value={String(stats.total)} sub="in latest run" />
              <StatTile label="avg judge score" value={stats.avgScore.toFixed(2)} unit="/ 5" sub="LLM-as-judge" />
              <StatTile
                label="avg latency"
                value={Math.round(stats.avgLatency).toLocaleString()}
                unit="ms"
                sub="per agent call"
              />
            </div>
          </section>

          {/* Category breakdown — hand-built horizontal bars */}
          <section className="rise rounded-xl border border-line bg-panel/40 p-6">
            <Rule aside={`${categoryData.length} categories`}>pass rate by category</Rule>
            <div className="space-y-3.5">
              {categoryData.map((c) => (
                <div key={c.category} className="grid grid-cols-[150px_1fr_auto] items-center gap-4">
                  <span className="mono truncate text-[12px] text-muted">{c.category}</span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-panel-2 ring-1 ring-inset ring-line">
                    <div
                      className="h-full rounded-full transition-[width] duration-700 ease-out"
                      style={{ width: `${c.passRate}%`, background: tone(c.passRate) }}
                    />
                  </div>
                  <span className="mono w-[88px] text-right text-[12px]">
                    <span style={{ color: tone(c.passRate) }}>{c.passRate}%</span>
                    <span className="text-faint"> · {c.passed}/{c.total}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Run log */}
          <section className="rise rounded-xl border border-line bg-panel/40 p-6">
            <Rule aside={`${runs.length} total`}>run log</Rule>
            <div className="space-y-2">
              {runs.map((run) => {
                const open = expanded.has(run.run_id);
                return (
                  <div
                    key={run.run_id}
                    className="overflow-hidden rounded-lg border border-line bg-panel-2/60"
                  >
                    <button
                      className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                      aria-expanded={open}
                      onClick={() => {
                        const next = new Set(expanded);
                        next.has(run.run_id) ? next.delete(run.run_id) : next.add(run.run_id);
                        setExpanded(next);
                      }}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: tone(run.rate) }}
                        aria-hidden
                      />
                      <span className="mono flex-1 truncate text-[13px] text-ink">{run.run_id}</span>
                      {run.when && (
                        <span className="mono hidden text-[11px] text-faint sm:inline">
                          {new Date(run.when).toLocaleDateString()}
                        </span>
                      )}
                      <span className="mono text-[12px] text-muted">
                        {run.passed}/{run.total}
                      </span>
                      <span className="mono w-12 text-right text-[12px]" style={{ color: tone(run.rate) }}>
                        {run.rate}%
                      </span>
                      <span className="mono w-3 text-faint" aria-hidden>{open ? '−' : '+'}</span>
                    </button>
                    {open && (
                      <div className="overflow-x-auto border-t border-line">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="mono text-[10px] uppercase tracking-[0.14em] text-faint">
                              <th className="px-4 py-2 font-medium">case</th>
                              <th className="px-4 py-2 font-medium">category</th>
                              <th className="px-4 py-2 font-medium">tool</th>
                              <th className="px-4 py-2 font-medium text-right">score</th>
                              <th className="px-4 py-2 font-medium text-right">latency</th>
                            </tr>
                          </thead>
                          <tbody>
                            {run.items.map((i) => {
                              const caseOpen = openCases.has(i.id);
                              return (
                                <Fragment key={i.id}>
                                  <tr
                                    className="cursor-pointer border-t border-line/60 transition-colors hover:bg-white/[0.03]"
                                    aria-expanded={caseOpen}
                                    onClick={() => {
                                      const next = new Set(openCases);
                                      next.has(i.id) ? next.delete(i.id) : next.add(i.id);
                                      setOpenCases(next);
                                    }}
                                  >
                                    <td className="mono px-4 py-2 text-[12px] text-ink">
                                      <span className="mr-2 inline-block w-2 text-faint" aria-hidden>
                                        {caseOpen ? '−' : '+'}
                                      </span>
                                      {i.test_case_id}
                                    </td>
                                    <td className="mono px-4 py-2 text-[12px] text-muted">{i.category}</td>
                                    <td className="mono px-4 py-2 text-[12px] text-muted">
                                      {i.actual_tool_called ?? '—'}
                                    </td>
                                    <td className="mono px-4 py-2 text-right text-[12px]">
                                      <span style={{ color: i.passed ? 'var(--brand)' : 'var(--warn)' }}>
                                        {i.judge_score ?? '—'}/5
                                      </span>
                                    </td>
                                    <td className="mono px-4 py-2 text-right text-[12px] text-muted">
                                      {i.latency_ms != null ? `${i.latency_ms.toLocaleString()}ms` : '—'}
                                    </td>
                                  </tr>
                                  {caseOpen && (
                                    <tr className="border-t border-line/60 bg-bg/30">
                                      <td colSpan={5} className="p-0">
                                        <CaseTrace row={i} />
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Legend footer */}
          <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-5">
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-faint">thresholds</span>
            {[
              ['≥ 80%', 'var(--brand)'],
              ['50–79%', 'var(--warn)'],
              ['< 50%', 'var(--danger)'],
            ].map(([label, c]) => (
              <span key={label} className="mono flex items-center gap-2 text-[11px] text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: c }} />
                {label}
              </span>
            ))}
          </footer>
        </>
      )}
    </div>
  );
}
