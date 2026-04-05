"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, createContext, useContext } from "react";
import { Sidebar } from "@/components/sidebar";
import { WeekSelector } from "@/components/week-selector";
import { SyncButton } from "@/components/sync-button";
import { UserMenu } from "@/components/user-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { Suspense } from "react";
import { CreditBadge } from "@/components/credit-badge";

export interface Session {
  memberId: string;
  name: string;
  role: string;
  isAdmin: boolean;
}

const SessionContext = createContext<Session | null>(null);
export function useSession() { return useContext(SessionContext); }

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/auth")
      .then(r => r.json())
      .then(d => setSession(d.session || null))
      .catch(() => {});
  }, [isLoginPage]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-screen max-w-[100vw] overflow-hidden">
        <Suspense fallback={<aside className="w-56 flex-shrink-0 bg-[var(--navbar)] border-r min-h-screen" />}>
          <Sidebar />
        </Suspense>
        <main className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b border-[var(--border)] bg-[var(--card)] flex items-center justify-between px-6">
            <Suspense fallback={<div className="h-10 w-56 bg-[var(--muted)] animate-pulse rounded-lg" />}>
              {pathname.startsWith("/ceo") ? (
                <div className="text-sm font-medium text-[var(--muted-foreground)]">CEO Finance</div>
              ) : (
                <WeekSelector />
              )}
            </Suspense>
            <div className="flex items-center gap-3">
              {session?.role === "setter" && (
                <a href="/blasts"><CreditBadge setterId={session.memberId} /></a>
              )}
              <SyncButton />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <div className="flex-1 p-6 overflow-x-hidden">
            <Suspense fallback={<div className="animate-pulse">Loading...</div>}>
              {children}
            </Suspense>
          </div>
        </main>
      </div>
    </SessionContext.Provider>
  );
}
