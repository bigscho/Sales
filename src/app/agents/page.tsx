"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface AgentRecord {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  state: string | null;
  city: string | null;
  zip: string | null;
  brokerage: string | null;
  totalTransactions: number | null;
  avgTransactions: number | null;
  totalVolumeCents: string | null;
  avgVolumeCents: string | null;
  emailVerifyStatus: string | null;
  outboundPushes: { channel: string; campaignId: string; pushedAt: string }[];
}

interface AgentsResponse {
  agents: AgentRecord[];
  total: number;
  page: number;
  totalPages: number;
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
];

function formatVolume(cents: string | null): string {
  if (!cents) return "—";
  const dollars = Number(cents) / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

export default function AgentsPage() {
  const [data, setData] = useState<AgentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [minProd, setMinProd] = useState("");
  const [maxProd, setMaxProd] = useState("");
  const [contacted, setContacted] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<NodeJS.Timeout>();

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", "50");
    if (search) params.set("search", search);
    if (state) params.set("state", state);
    if (city) params.set("city", city);
    if (minProd) params.set("minProd", minProd);
    if (maxProd) params.set("maxProd", maxProd);
    if (contacted) params.set("contacted", contacted);

    const res = await fetch(`/api/agents?${params}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, [page, search, state, city, minProd, maxProd, contacted]);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  // Debounced search
  const handleSearchChange = (val: string) => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(val);
      setPage(1);
    }, 300);
  };

  const handleSelectAll = () => {
    if (!data) return;
    if (selected.size === data.agents.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.agents.map((a) => a.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleDriveImport = async () => {
    setImporting(true);
    setImportResult("Connecting to Google Drive...");

    try {
      // First, list files to show what we found
      const listRes = await fetch("/api/agents/gdrive");
      const listData = await listRes.json();

      if (!listRes.ok) {
        setImportResult(`Error: ${listData.error || "Failed to connect to Google Drive"}`);
        setImporting(false);
        return;
      }

      setImportResult(`Found ${listData.totalFiles} files in Google Drive. Importing...`);

      // Now actually import
      const importRes = await fetch("/api/agents/gdrive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const importData = await importRes.json();

      const filesSummary = importData.fileResults
        ?.map((f: { name: string; imported: number; updated: number; skipped: number; error?: string }) =>
          f.error ? `${f.name}: ERROR — ${f.error}` : `${f.name}: ${f.imported} new, ${f.updated} updated`
        )
        .join("\n");

      setImportResult(
        `Done! ${importData.filesProcessed} files processed.\n` +
        `${importData.totalImported} new agents, ${importData.totalUpdated} updated, ${importData.totalSkipped} skipped.\n\n` +
        filesSummary
      );
      fetchAgents();
    } catch (err) {
      setImportResult(`Error: ${String(err)}`);
    }

    setImporting(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim());
      if (lines.length < 2) {
        setImportResult("CSV file is empty or has no data rows");
        setImporting(false);
        return;
      }

      // Parse headers
      const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());

      // Map columns to agent fields
      const colMap = buildColumnMap(headers);

      // Parse data rows
      const agents = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length < 2) continue;

        const row: Record<string, string> = {};

        // Handle full name (homes.com) vs separate first/last
        if (colMap.fullName !== -1 && cols[colMap.fullName]) {
          const parts = cols[colMap.fullName].trim().split(/\s+/);
          row.firstName = parts[0] || "";
          row.lastName = parts.slice(1).join(" ") || "";
        }
        if (colMap.firstName !== -1 && cols[colMap.firstName]) row.firstName = cols[colMap.firstName];
        if (colMap.lastName !== -1 && cols[colMap.lastName]) row.lastName = cols[colMap.lastName];

        // Handle multiple emails (homes.com sometimes has comma-separated)
        if (colMap.email !== -1) {
          const emailRaw = cols[colMap.email] || "";
          row.email = emailRaw.split(",")[0].trim(); // take first email
        }

        if (colMap.phone !== -1) row.phone = cols[colMap.phone] || "";
        if (colMap.state !== -1) row.state = cols[colMap.state] || "";
        if (colMap.city !== -1) row.city = cols[colMap.city] || "";
        if (colMap.zip !== -1) row.zip = cols[colMap.zip] || "";
        if (colMap.brokerage !== -1) row.brokerage = cols[colMap.brokerage] || "";
        if (colMap.transactions !== -1) row.totalTransactions = cols[colMap.transactions] || "";
        if (colMap.volume !== -1) row.total_volume = cols[colMap.volume] || "";

        if (row.email || (row.firstName && row.lastName)) {
          agents.push(row);
        }
      }

      // Send in batches of 1000
      let totalImported = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;
      const batchName = file.name.replace(/\.[^.]+$/, "");
      const batchSize = 1000;

      for (let i = 0; i < agents.length; i += batchSize) {
        const batch = agents.slice(i, i + batchSize);
        const res = await fetch("/api/agents/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agents: batch, batchName }),
        });
        const result = await res.json();
        totalImported += result.imported || 0;
        totalUpdated += result.updated || 0;
        totalSkipped += result.skipped || 0;
      }

      setImportResult(`Done! ${totalImported} new, ${totalUpdated} updated, ${totalSkipped} skipped (${agents.length} total rows)`);
      fetchAgents();
    } catch (err) {
      setImportResult(`Error: ${String(err)}`);
    }

    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Agent Database</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            {data ? `${data.total.toLocaleString()} agents` : "Loading..."}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            onClick={handleDriveImport}
            disabled={importing}
          >
            {importing ? "Importing..." : "Import from Google Drive"}
          </Button>
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            variant="outline"
          >
            Upload CSV
          </Button>
        </div>
      </div>

      {importResult && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <pre className="text-sm whitespace-pre-wrap font-sans">{importResult}</pre>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card className="mb-4">
        <CardContent className="py-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">Search</label>
              <input
                type="text"
                placeholder="Name, email, brokerage..."
                className="border rounded px-3 py-1.5 text-sm w-52"
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">State</label>
              <select
                className="border rounded px-3 py-1.5 text-sm"
                value={state}
                onChange={(e) => { setState(e.target.value); setPage(1); }}
              >
                <option value="">All States</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">City</label>
              <input
                type="text"
                placeholder="City..."
                className="border rounded px-3 py-1.5 text-sm w-32"
                value={city}
                onChange={(e) => { setCity(e.target.value); setPage(1); }}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">Avg Transactions (min)</label>
              <input
                type="number"
                placeholder="0"
                className="border rounded px-3 py-1.5 text-sm w-20"
                value={minProd}
                onChange={(e) => { setMinProd(e.target.value); setPage(1); }}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">Avg Transactions (max)</label>
              <input
                type="number"
                placeholder="∞"
                className="border rounded px-3 py-1.5 text-sm w-20"
                value={maxProd}
                onChange={(e) => { setMaxProd(e.target.value); setPage(1); }}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--muted-foreground)] mb-1">Contacted</label>
              <select
                className="border rounded px-3 py-1.5 text-sm"
                value={contacted}
                onChange={(e) => { setContacted(e.target.value); setPage(1); }}
              >
                <option value="">All</option>
                <option value="false">Never Contacted</option>
                <option value="true">Contacted</option>
              </select>
            </div>
            <Button variant="outline" size="sm" onClick={() => {
              setSearch(""); setState(""); setCity(""); setMinProd(""); setMaxProd(""); setContacted(""); setPage(1);
            }}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium text-green-800">
            {selected.size} agent{selected.size > 1 ? "s" : ""} selected
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => alert("Push to Smartlead — coming in Phase 2")}>
              Push to Email Campaign
            </Button>
            <Button size="sm" variant="outline" onClick={() => alert("Push to GHL — coming in Phase 2")}>
              Push to SMS Campaign
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
              Clear Selection
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-[var(--muted)]">
                  <th className="p-3 text-left w-8">
                    <input
                      type="checkbox"
                      checked={data ? selected.size === data.agents.length && data.agents.length > 0 : false}
                      onChange={handleSelectAll}
                    />
                  </th>
                  <th className="p-3 text-left">Name</th>
                  <th className="p-3 text-left">Email</th>
                  <th className="p-3 text-left">Phone</th>
                  <th className="p-3 text-left">Location</th>
                  <th className="p-3 text-left">Brokerage</th>
                  <th className="p-3 text-right">Txns (5yr)</th>
                  <th className="p-3 text-right">Avg Txns/yr</th>
                  <th className="p-3 text-right">Volume (5yr)</th>
                  <th className="p-3 text-right">Avg Vol/yr</th>
                  <th className="p-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} className="p-8 text-center text-[var(--muted-foreground)]">Loading...</td></tr>
                ) : data?.agents.length === 0 ? (
                  <tr><td colSpan={11} className="p-8 text-center text-[var(--muted-foreground)]">
                    No agents found. Import a CSV to get started.
                  </td></tr>
                ) : data?.agents.map((agent) => (
                  <tr
                    key={agent.id}
                    className={`border-b hover:bg-[var(--muted)] cursor-pointer ${selected.has(agent.id) ? "bg-green-50" : ""}`}
                    onClick={() => toggleSelect(agent.id)}
                  >
                    <td className="p-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(agent.id)}
                        onChange={() => toggleSelect(agent.id)}
                      />
                    </td>
                    <td className="p-3 font-medium">
                      {agent.firstName} {agent.lastName}
                    </td>
                    <td className="p-3 text-[var(--muted-foreground)]">
                      {agent.email || "—"}
                    </td>
                    <td className="p-3 text-[var(--muted-foreground)]">
                      {agent.phone || "—"}
                    </td>
                    <td className="p-3">
                      {[agent.city, agent.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="p-3 text-[var(--muted-foreground)]">
                      {agent.brokerage || "—"}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {agent.totalTransactions ?? "—"}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {agent.avgTransactions ?? "—"}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {formatVolume(agent.totalVolumeCents)}
                    </td>
                    <td className="p-3 text-right font-mono">
                      {formatVolume(agent.avgVolumeCents)}
                    </td>
                    <td className="p-3 text-center">
                      <div className="flex gap-1 justify-center">
                        {agent.outboundPushes.length === 0 ? (
                          <span className="text-xs text-[var(--muted-foreground)]">—</span>
                        ) : (
                          <>
                            {agent.outboundPushes.some((p) => p.channel === "smartlead") && (
                              <Badge variant="secondary" className="text-xs">Email</Badge>
                            )}
                            {agent.outboundPushes.some((p) => p.channel === "ghl") && (
                              <Badge variant="secondary" className="text-xs">SMS</Badge>
                            )}
                          </>
                        )}
                        {agent.emailVerifyStatus && (
                          <Badge
                            variant={agent.emailVerifyStatus === "valid" ? "success" : "danger"}
                            className="text-xs"
                          >
                            {agent.emailVerifyStatus}
                          </Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-sm text-[var(--muted-foreground)]">
                Page {data.page} of {data.totalPages} ({data.total.toLocaleString()} total)
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Simple CSV line parser that handles quoted fields
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Map CSV headers to our field names — handles various column naming conventions
// homes.com format: agent_full_name, emails, agent_phone_number, city, state, closed_sales, total_value, agency_name, lisence_number
function buildColumnMap(headers: string[]) {
  const find = (patterns: string[]) => {
    for (const p of patterns) {
      const idx = headers.findIndex((h) => h.includes(p));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  return {
    fullName: find(["agent_full_name", "full_name", "full name", "agent name"]),
    firstName: find(["first_name", "first name", "firstname", "fname"]),
    lastName: find(["last_name", "last name", "lastname", "lname"]),
    email: find(["emails", "email", "e-mail", "email address"]),
    phone: find(["agent_phone_number", "phone", "mobile", "cell", "telephone"]),
    state: find(["state", "st"]),
    city: find(["city"]),
    zip: find(["zip", "postal", "zipcode"]),
    brokerage: find(["agency_name", "brokerage", "company", "office", "firm"]),
    transactions: find(["closed_sales", "transaction", "txn", "deals", "sales count", "total transactions"]),
    volume: find(["total_value", "volume", "sales volume", "total volume", "gci", "total sales"]),
    licenseNumber: find(["lisence_number", "license_number", "license"]),
    profileLink: find(["agent_profile_link", "profile_link"]),
    yearsExperience: find(["years_experience", "experience"]),
    priceRange: find(["price_range"]),
    averagePrice: find(["average_price"]),
  };
}
