"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/app-shell";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles?: string[]; // if set, only these roles + admin see it
}

const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "📊", roles: ["admin"] },
  { href: "/demos", label: "Demos", icon: "📞" },
  { href: "/deals", label: "Deals", icon: "💰", roles: ["closer", "admin"] },
  { href: "/scoreboard", label: "Scoreboard", icon: "🏆", roles: ["setter", "closer", "show_rate_rep", "admin"] },
  { href: "/confirmations", label: "Confirmations", icon: "📆", roles: ["show_rate_rep", "admin"] },
  { href: "/blasts", label: "Text Blast", icon: "📲", roles: ["setter", "admin"] },
  { href: "/blasts/admin", label: "Blast Admin", icon: "⚡", roles: ["admin"] },
  { href: "/agents", label: "Agents", icon: "🏠", roles: ["admin"] },
  { href: "/outbound", label: "Outbound", icon: "📤", roles: ["admin"] },
  { href: "/smartlead", label: "Smartlead", icon: "📧", roles: ["admin"] },
  { href: "/verify/admin", label: "Verify", icon: "✅", roles: ["setter", "admin"] },
  { href: "https://www.youtube.com/watch?v=zIG39WlSCsM", label: "Motivation", icon: "🔥", roles: ["setter", "closer", "show_rate_rep", "admin"] },
  { href: "/payroll", label: "Payroll", icon: "💵", roles: ["admin"] },
  { href: "/pnl", label: "P&L", icon: "📈", roles: ["admin"] },
  { href: "/team", label: "Team", icon: "👥", roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: "⚙️", roles: ["admin"] },
];

const ceoNavItems = [
  { href: "/ceo", label: "CEO Home", icon: "🏦" },
  { href: "/ceo/review", label: "Weekly Review", icon: "✅" },
  { href: "/ceo/revenue", label: "Revenue", icon: "💰" },
  { href: "/ceo/expenses", label: "Expenses", icon: "📤" },
  { href: "/ceo/pnl", label: "CEO P&L", icon: "💹" },
];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const session = useSession();
  const weekId = searchParams.get("weekId") || "";

  const isAdmin = session?.isAdmin ?? false;
  const role = session?.role || "";

  // Filter nav items by role
  const visibleItems = navItems.filter(item => {
    if (!item.roles) return true; // visible to everyone
    if (isAdmin) return true;
    return item.roles.includes(role);
  });

  // For setters, the Verify link should go to their own verify page
  const getHref = (item: NavItem): string => {
    if (item.href === "/verify/admin" && role === "setter" && !isAdmin && session?.memberId) {
      return `/verify?weekId=${weekId}&setter=${session.memberId}`;
    }
    return item.href;
  };

  return (
    <aside className="w-56 flex-shrink-0 bg-[var(--navbar)] border-r border-[var(--border)] min-h-screen flex flex-col">
      <div className="h-16 border-b border-white/10 flex items-center justify-center px-4">
        <Image src="/logos/logo-light.png" alt="Grassfed" width={180} height={48} className="h-10 w-auto" />
      </div>
      <nav className="flex-1 p-2">
        {visibleItems.map((item) => {
          const href = getHref(item);
          const isExternal = href.startsWith("http");
          const isActive = !isExternal && (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href));

          if (isExternal) {
            return (
              <a
                key={item.href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
                  "text-white/60 hover:bg-white/10 hover:text-white"
                )}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </a>
            );
          }

          return (
            <Link
              key={item.href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
                isActive
                  ? "bg-white/10 text-[var(--accent)] border-l-2 border-[var(--lime)]"
                  : "text-white/60 hover:bg-white/10 hover:text-white border-l-2 border-transparent"
              )}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <div className="border-t border-white/10 my-3" />
            <p className="px-3 py-1 text-xs font-semibold text-white/40 uppercase tracking-wider">
              CEO Finance
            </p>
            {ceoNavItems.map((item) => {
              const isActive = item.href === "/ceo" ? pathname === "/ceo" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
                    isActive
                      ? "bg-white/10 text-[var(--accent)] border-l-2 border-[var(--lime)]"
                      : "text-white/60 hover:bg-white/10 hover:text-white border-l-2 border-transparent"
                  )}
                >
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>
    </aside>
  );
}
