"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function SmartleadImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [campaignName, setCampaignName] = useState("Grsfd Internal Outreach 2026");
  const [override, setOverride] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success?: boolean;
    error?: string;
    leads_imported?: number;
    campaign?: { id: number; name: string };
    smartlead_response?: unknown;
  } | null>(null);

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("campaign_name", campaignName);
    formData.append("override", override.toString());

    try {
      const res = await fetch("/api/smartlead/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Smartlead Import</h2>

      <Card>
        <CardHeader>
          <CardTitle>Import Leads to Campaign</CardTitle>
          <CardDescription>
            Upload a CSV file to import leads into a Smartlead campaign. Enable
            override to update leads that already exist in the campaign.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Campaign Name</label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Enter campaign name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">CSV File</label>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full border rounded px-3 py-2 text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              CSV must include an &quot;email&quot; column. Optional columns: first_name, last_name,
              company, phone, website, and any custom fields.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="override"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              className="rounded"
            />
            <label htmlFor="override" className="text-sm">
              Override existing leads (ignore duplicates in other campaigns)
            </label>
          </div>

          <Button onClick={handleImport} disabled={!file || !campaignName || loading}>
            {loading ? "Importing..." : "Import Leads"}
          </Button>

          {result && (
            <div
              className={`mt-4 p-4 rounded text-sm ${
                result.success
                  ? "bg-green-50 border border-green-200 text-green-800"
                  : "bg-red-50 border border-red-200 text-red-800"
              }`}
            >
              {result.success ? (
                <div>
                  <p className="font-medium">Import successful!</p>
                  <p>
                    {result.leads_imported} leads imported to campaign &quot;{result.campaign?.name}&quot;
                    (ID: {result.campaign?.id})
                  </p>
                </div>
              ) : (
                <div>
                  <p className="font-medium">Import failed</p>
                  <p>{result.error}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
