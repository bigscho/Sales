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
  accessRole?: string | null; // overrides `role` for nav/route access only
  isAdmin: boolean;
}

const SessionContext = createContext<Session | null>(null);
export function useSession() { return useContext(SessionContext); }

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";
  const [session, setSession] = useState<Session | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/auth")
      .then(r => r.json())
      .then(d => setSession(d.session || null))
      .catch(() => {});
  }, [isLoginPage]);

  // Close the mobile drawer whenever the route changes
  useEffect(() => { setNavOpen(false); }, [pathname]);

  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-screen max-w-[100vw] overflow-hidden">
        {/* Desktop sidebar — sticky so nav stays visible on long pages */}
        <div className="hidden md:block w-56 flex-shrink-0">
          <div className="sticky top-0 h-screen">
            <Suspense fallback={<aside className="w-56 h-full bg-[var(--navbar)] border-r" />}>
              <Sidebar />
            </Suspense>
          </div>
        </div>

        {/* Mobile drawer */}
        {navOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setNavOpen(false)}
              aria-hidden
            />
            <div className="absolute inset-y-0 left-0 shadow-xl">
              <Suspense fallback={<aside className="w-56 h-full bg-[var(--navbar)]" />}>
                <Sidebar onNavigate={() => setNavOpen(false)} />
              </Suspense>
            </div>
          </div>
        )}

        <main className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b border-[var(--border)] bg-[var(--card)] flex items-center justify-between gap-2 px-3 md:px-6">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                onClick={() => setNavOpen(true)}
                className="md:hidden h-10 w-10 flex-shrink-0 flex items-center justify-center rounded-lg border border-[var(--border)] text-[var(--foreground)]"
                aria-label="Open menu"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <Suspense fallback={<div className="h-10 w-40 bg-[var(--muted)] animate-pulse rounded-lg" />}>
                {pathname.startsWith("/ceo") ? (
                  <div className="text-sm font-medium text-[var(--muted-foreground)]">CEO Finance</div>
                ) : (
                  <WeekSelector />
                )}
              </Suspense>
            </div>
            <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
              {session && (session.accessRole || session.role) === "setter" && (
                <a href="/blasts"><CreditBadge setterId={session.memberId} /></a>
              )}
              <SyncButton />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <div className="flex-1 p-3 md:p-6 overflow-x-hidden">
            <Suspense fallback={<div className="animate-pulse">Loading...</div>}>
              {children}
            </Suspense>
          </div>
        </main>
      </div>
    </SessionContext.Provider>
  );
}
