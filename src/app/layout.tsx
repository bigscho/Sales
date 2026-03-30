import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { WeekSelector } from "@/components/week-selector";
import { SyncButton } from "@/components/sync-button";
import { Suspense } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grassfed Sales Tracker",
  description: "Weekly KPIs, Payroll & P&L Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 flex flex-col">
            <header className="h-16 border-b border-[var(--border)] bg-white flex items-center justify-between px-6">
              <Suspense fallback={<div className="h-10 w-56 bg-gray-100 animate-pulse rounded-lg" />}>
                <WeekSelector />
              </Suspense>
              <div className="flex items-center gap-3">
                <SyncButton />
              </div>
            </header>
            <div className="flex-1 p-6">
              <Suspense fallback={<div className="animate-pulse">Loading...</div>}>
                {children}
              </Suspense>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
