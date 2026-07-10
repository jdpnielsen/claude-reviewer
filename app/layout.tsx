import type { Metadata } from "next";
import "./globals.css";
import { GitPullRequest } from 'lucide-react';
import Link from 'next/link';
import { HeaderNav } from '@/components/HeaderNav';
import { ConfirmProvider } from '@/components/ConfirmDialog';

export const metadata: Metadata = {
  title: "Claude Reviewer - Local PR Review",
  description: "Review Claude's code changes locally with inline commenting",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ConfirmProvider>
          <header>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontWeight: 600, fontSize: '1.25rem', textDecoration: 'none', color: 'inherit' }}>
                <GitPullRequest size={24} />
                Claude Reviewer
              </Link>
              <HeaderNav />
            </div>
            <div style={{ fontSize: '0.9rem', color: '#8b949e' }}>
              Local Code Review System
            </div>
          </header>
          {children}
        </ConfirmProvider>
      </body>
    </html>
  );
}
