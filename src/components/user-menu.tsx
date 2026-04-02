"use client";

import { useRouter } from "next/navigation";
import { useSession } from "@/components/app-shell";

export function UserMenu() {
  const router = useRouter();
  const session = useSession();

  const handleLogout = async () => {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
    router.refresh();
  };

  if (!session) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-600">{session.name}</span>
      <span className="text-xs text-gray-400">({session.isAdmin ? "admin" : session.role})</span>
      <button
        onClick={handleLogout}
        className="text-xs text-gray-400 hover:text-red-500 ml-1"
      >
        Logout
      </button>
    </div>
  );
}
