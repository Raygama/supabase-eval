import EvalDashboard from '../components/EvalDashboard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <EvalDashboard />
    </main>
  );
}
