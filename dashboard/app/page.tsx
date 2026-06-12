import EvalDashboard from '../components/EvalDashboard';

export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <main className="mx-auto min-h-screen max-w-[1180px] px-5 py-10 sm:px-8 sm:py-14">
      <EvalDashboard />
    </main>
  );
}
