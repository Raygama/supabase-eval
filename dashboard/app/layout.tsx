import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'supabase-eval · telemetry',
  description: 'Evaluation telemetry for the supabase-eval AI agent',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
