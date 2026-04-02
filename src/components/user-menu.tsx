"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Session {
  memberId: string;
  name: string;
  role: string;
  isAdmin: boolean;
}

export function UserMenu() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    fetch("/api/auth")
      .then(r => r.json())
      .then(d => setSession(d.session))
      .catch(() => {});
  }, []);

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
