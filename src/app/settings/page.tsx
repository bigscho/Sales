"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface SyncLogRecord {
  id: string;
  source: string;
  syncType: string;
  status: string;
  recordsSynced: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface CategoryRecord {
  id: string;
  name: string;
  isActive: boolean;
}

export default function SettingsPage() {
  const [syncLogs, setSyncLogs] = useState<SyncLogRecord[]>([]);
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [newCategory, setNewCategory] = useState("");

  const loadData = useCallback(() => {
    fetch("/api/settings").then((r) => r.json()).then((data) => {
      setSyncLogs(data.syncLogs || []);
      setCategories(data.categories || []);
    });
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const addCategory = async () => {
    if (!newCategory.trim()) return;
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_category", name: newCategory.trim() }),
    });
    setNewCategory("");
    loadData();
  };

  const deleteCategory = async (id: string) => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_category", id }),
    });
    loadData();
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* Expense Categories */}
      <Card>
        <CardHeader>
          <CardTitle>Expense Categories</CardTitle>
          <CardDescription>Manage the categories available for P&L expenses</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 mb-4">
            <input
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="New category name"
              className="border rounded-lg px-3 py-2 text-sm flex-1"
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
            />
            <Button size="sm" onClick={addCategory}>Add</Button>
          </div>
          <div className="space-y-2">
            {categories.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <span className="text-sm">{c.name}</span>
                <button onClick={() => deleteCategory(c.id)} className="text-red-500 text-xs hover:underline">
                  Remove
                </button>
              </div>
            ))}
            {categories.length === 0 && (
              <p className="text-sm text-[var(--muted-foreground)]">No custom categories. Default categories are always available.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Environment Variables Status */}
      <Card>
        <CardHeader>
          <CardTitle>Integration Status</CardTitle>
          <CardDescription>API keys and webhook configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <EnvStatus name="STRIPE_SECRET_KEY" label="Stripe" />
            <EnvStatus name="SLACK_WEBHOOK_URL" label="Slack Notifications" />
            <EnvStatus name="GOOGLE_CALENDAR_CREDENTIALS" label="Google Calendar" />
            <EnvStatus name="AIRTABLE_API_KEY" label="Airtable" />
            <EnvStatus name="FIREFLIES_API_KEY" label="Fireflies" />
          </div>
          <p className="text-xs text-[var(--muted-foreground)] mt-4">
            Set these in your .env.local file or Vercel environment variables.
          </p>
        </CardContent>
      </Card>

      {/* Sync Logs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sync History</CardTitle>
        </CardHeader>
        <CardContent>
          {syncLogs.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr>
                  <th className="text-left p-2 font-medium">Source</th>
                  <th className="text-left p-2 font-medium">Status</th>
                  <th className="text-right p-2 font-medium">Records</th>
                  <th className="text-left p-2 font-medium">Time</th>
                  <th className="text-left p-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {syncLogs.map((log) => (
                  <tr key={log.id} className="border-b last:border-0">
                    <td className="p-2 capitalize">{log.source}</td>
                    <td className="p-2">
                      <span className={`text-xs font-medium ${log.status === "success" ? "text-green-600" : "text-red-600"}`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="p-2 text-right">{log.recordsSynced}</td>
                    <td className="p-2 text-xs text-[var(--muted-foreground)]">
                      {new Date(log.startedAt).toLocaleString()}
                    </td>
                    <td className="p-2 text-xs text-red-500">{log.errorMessage || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">No sync history yet. Click &quot;Sync Data&quot; to pull data from your integrations.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EnvStatus({ name, label }: { name: string; label: string }) {
  // We can't check env vars client-side, so this is just informational
  return (
    <div className="flex items-center justify-between py-1">
      <span>{label}</span>
      <code className="text-xs bg-[var(--muted)] px-2 py-1 rounded">{name}</code>
    </div>
  );
}
