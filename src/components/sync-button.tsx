"use client";

import { useState } from "react";

export function SyncButton() {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      const parts: string[] = [];
      for (const [source, r] of Object.entries(data.results || {})) {
        const info = r as { status: string; records?: number; error?: string };
        if (info.status === "success") {
          parts.push(`${source}: ${info.records || 0} synced`);
        } else {
          parts.push(`${source}: error`);
        }
      }
      setResult(parts.join(" | ") || "Sync complete");
      // Reload page to show new data
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setResult("Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span className="hidden md:inline text-xs text-[var(--muted-foreground)]">{result}</span>
      )}
      <button
        onClick={handleSync}
        disabled={syncing}
        className="h-9 px-3 md:px-4 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
      >
        {syncing ? "Syncing..." : <><span className="md:hidden">Sync</span><span className="hidden md:inline">Sync Data</span></>}
      </button>
    </div>
  );
}
