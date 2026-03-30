"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/demos", label: "Demos", icon: "📞" },
  { href: "/deals", label: "Deals", icon: "💰" },
  { href: "/payroll", label: "Payroll", icon: "💵" },
  { href: "/pnl", label: "P&L", icon: "📈" },
  { href: "/team", label: "Team", icon: "👥" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-white border-r border-[var(--border)] min-h-screen flex flex-col">
      <div className="p-4 border-b border-[var(--border)]">
        <h1 className="text-xl font-bold text-[var(--primary)]">Grassfed</h1>
        <p className="text-xs text-[var(--muted-foreground)]">Sales Tracker</p>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
                isActive
                  ? "bg-green-50 text-[var(--primary)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              )}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
