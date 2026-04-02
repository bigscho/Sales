"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { WeekSelector } from "@/components/week-selector";
import { SyncButton } from "@/components/sync-button";
import { UserMenu } from "@/components/user-menu";
import { Suspense } from "react";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col">
        <header className="h-16 border-b border-[var(--border)] bg-white flex items-center justify-between px-6">
          <Suspense fallback={<div className="h-10 w-56 bg-gray-100 animate-pulse rounded-lg" />}>
            <WeekSelector />
          </Suspense>
          <div className="flex items-center gap-3">
            <SyncButton />
            <UserMenu />
          </div>
        </header>
        <div className="flex-1 p-6">
          <Suspense fallback={<div className="animate-pulse">Loading...</div>}>
            {children}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
