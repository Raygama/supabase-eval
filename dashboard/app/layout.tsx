import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'supabase-eval dashboard',
  description: 'Eval results for the supabase-eval AI agent',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
