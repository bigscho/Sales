const SMARTLEAD_BASE_URL = "https://server.smartlead.ai/api/v1";

function getApiKey(): string {
  const key = process.env.SMARTLEAD_API_KEY;
  if (!key) throw new Error("SMARTLEAD_API_KEY environment variable is not set");
  return key;
}

export interface SmartleadCampaign {
  id: number;
  name: string;
  status: string;
  created_at: string;
}

export interface SmartleadLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone_number?: string;
  website?: string;
  custom_fields?: Record<string, string>;
  [key: string]: unknown;
}

export interface ImportSettings {
  ignore_global_block_list: boolean;
  ignore_unsubscribe_list: boolean;
  ignore_community_bounce_list: boolean;
  ignore_duplicate_leads_in_other_campaign: boolean;
}

interface ImportResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
  upload_count?: number;
  duplicate_count?: number;
}

export async function listCampaigns(): Promise<SmartleadCampaign[]> {
  const res = await fetch(`${SMARTLEAD_BASE_URL}/campaigns?api_key=${getApiKey()}`);
  if (!res.ok) {
    throw new Error(`Failed to list campaigns: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function findCampaignByName(name: string): Promise<SmartleadCampaign | null> {
  const campaigns = await listCampaigns();
  return campaigns.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function importLeadsToCampaign(
  campaignId: number,
  leads: SmartleadLead[],
  override: boolean = false
): Promise<ImportResponse> {
  const settings: ImportSettings = {
    ignore_global_block_list: false,
    ignore_unsubscribe_list: false,
    ignore_community_bounce_list: false,
    ignore_duplicate_leads_in_other_campaign: override,
  };

  const res = await fetch(
    `${SMARTLEAD_BASE_URL}/campaigns/${campaignId}/leads?api_key=${getApiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_list: leads, settings }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    return { ok: false, error: `Smartlead API error: ${res.status} ${errorText}` };
  }

  const data = await res.json();
  return { ok: true, data, upload_count: data.upload_count, duplicate_count: data.duplicate_count };
}

export function parseCSVToLeads(csvContent: string): SmartleadLead[] {
  const lines = csvContent.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));

  const emailIdx = headers.findIndex((h) => h === "email" || h === "email_address" || h === "email address");
  if (emailIdx === -1) throw new Error("CSV must contain an 'email' column");

  const fieldMap: Record<string, string> = {
    first_name: "first_name",
    firstname: "first_name",
    "first name": "first_name",
    last_name: "last_name",
    lastname: "last_name",
    "last name": "last_name",
    company: "company_name",
    company_name: "company_name",
    "company name": "company_name",
    phone: "phone_number",
    phone_number: "phone_number",
    "phone number": "phone_number",
    website: "website",
  };

  const leads: SmartleadLead[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parsing (handles quoted fields with commas)
    const values = parseCSVLine(line);
    const email = values[emailIdx]?.trim().replace(/['"]/g, "");
    if (!email) continue;

    const lead: SmartleadLead = { email };
    const customFields: Record<string, string> = {};

    headers.forEach((header, idx) => {
      if (idx === emailIdx) return;
      const value = values[idx]?.trim().replace(/^['"]|['"]$/g, "") || "";
      if (!value) return;

      const mappedField = fieldMap[header];
      if (mappedField) {
        (lead as Record<string, unknown>)[mappedField] = value;
      } else {
        customFields[header] = value;
      }
    });

    if (Object.keys(customFields).length > 0) {
      lead.custom_fields = customFields;
    }

    leads.push(lead);
  }

  return leads;
}

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
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
