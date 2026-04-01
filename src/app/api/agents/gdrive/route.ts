import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getGoogleAccessToken } from "@/lib/google-auth";
import * as XLSX from "xlsx";

// Vercel Pro allows up to 300s for serverless functions
export const maxDuration = 300;

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER_ID = "1oUm4jzKSLpNKjr7qsntwSd8oApn1Wswa";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

// GET: List all files in the Raw States folder (for verification)
export async function GET() {
  try {
    const { clientEmail, privateKey } = getCredentials();
    const accessToken = await getGoogleAccessToken(clientEmail, privateKey, DRIVE_SCOPES);

    // Try listing files in the folder
    const files = await listFilesInFolder(accessToken, FOLDER_ID);

    // If no files found, try alternate queries for debugging
    if (files.length === 0) {
      // Debug: list ALL files the service account can see
      const debugParams = new URLSearchParams({
        pageSize: "10",
        fields: "files(id, name, mimeType, parents)",
        orderBy: "modifiedTime desc",
      });
      const debugRes = await fetch(`${DRIVE_API}/files?${debugParams}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const debugData = await debugRes.json();

      // Debug: try to get the folder metadata directly
      const folderRes = await fetch(`${DRIVE_API}/files/${FOLDER_ID}?fields=id,name,mimeType,shared`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const folderData = await folderRes.json();

      // Debug: try with supportsAllDrives
      const driveParams = new URLSearchParams({
        q: `'${FOLDER_ID}' in parents`,
        fields: "files(id, name, mimeType)",
        pageSize: "10",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      const driveRes = await fetch(`${DRIVE_API}/files?${driveParams}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const driveData = await driveRes.json();

      return NextResponse.json({
        folderId: FOLDER_ID,
        totalFiles: 0,
        files: [],
        debug: {
          folderMetadata: folderData,
          recentFiles: debugData.files || [],
          withAllDrives: driveData.files || [],
          driveError: driveData.error || null,
        },
      });
    }

    return NextResponse.json({
      folderId: FOLDER_ID,
      totalFiles: files.length,
      files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e), stack: (e as Error).stack?.slice(0, 500) }, { status: 500 });
  }
}

// POST: Import all CSV/Sheets files from the folder into the Agent database
// Supports: { fileName: "Massachusetts" } for single file
//           { batch: 1 } for batch 1 of 6 (8 files per batch)
//           {} for all files (may timeout)
export async function POST(request: NextRequest) {
  try {
  const body = await request.json().catch(() => ({}));

  // Wipe all agents before re-importing (use when data is corrupt)
  if (body.action === "wipe") {
    await prisma.outboundPush.deleteMany({});
    const deleted = await prisma.agent.deleteMany({});
    return NextResponse.json({ wiped: true, deleted: deleted.count });
  }

  const dryRun = body.dryRun === true;
  const fileFilter = body.fileName as string | undefined;
  const batchNum = body.batch as number | undefined; // 1-6
  const batchSize = 8;

  const { clientEmail, privateKey } = getCredentials();
  const accessToken = await getGoogleAccessToken(clientEmail, privateKey, DRIVE_SCOPES);

  const allFiles = await listFilesInFolder(accessToken, FOLDER_ID);

  // Filter to spreadsheet/CSV files only, and optionally by name
  let importableFiles = allFiles.filter((f) => {
    const isSpreadsheet =
      f.mimeType === "application/vnd.google-apps.spreadsheet" ||
      f.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      f.mimeType === "text/csv" ||
      f.name.endsWith(".csv") ||
      f.name.endsWith(".xlsx");
    if (!isSpreadsheet) return false;
    if (fileFilter && !f.name.toLowerCase().includes(fileFilter.toLowerCase())) return false;
    return true;
  });

  // Sort alphabetically for consistent batching
  importableFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Apply batch slicing if requested
  if (batchNum) {
    const start = (batchNum - 1) * batchSize;
    const end = start + batchSize;
    importableFiles = importableFiles.slice(start, end);
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      filesToImport: importableFiles.map((f) => f.name),
      totalFiles: importableFiles.length,
      totalBatches: Math.ceil(allFiles.length / batchSize),
    });
  }

  const results = {
    batch: batchNum || "all",
    filesProcessed: 0,
    totalImported: 0,
    totalUpdated: 0,
    totalSkipped: 0,
    fileResults: [] as { name: string; imported: number; updated: number; skipped: number; error?: string }[],
  };

  for (const file of importableFiles) {
    try {
      const rows = await downloadAndParseFile(accessToken, file);
      if (!rows || rows.length === 0) {
        results.fileResults.push({ name: file.name, imported: 0, updated: 0, skipped: 0, error: "Empty file" });
        continue;
      }

      const { imported, updated, skipped } = await importRows(rows, file.name);
      results.filesProcessed++;
      results.totalImported += imported;
      results.totalUpdated += updated;
      results.totalSkipped += skipped;
      results.fileResults.push({ name: file.name, imported, updated, skipped });
    } catch (e) {
      results.fileResults.push({ name: file.name, imported: 0, updated: 0, skipped: 0, error: String(e).slice(0, 200) });
    }
  }

  return NextResponse.json(results);
  } catch (e) {
    return NextResponse.json({ error: String(e), stack: (e as Error).stack?.slice(0, 500) }, { status: 500 });
  }
}

// --- Helpers ---

function getCredentials() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY not set");
  }
  return { clientEmail, privateKey: privateKeyRaw.replace(/\\n/g, "\n") };
}

async function listFilesInFolder(accessToken: string, folderId: string, recursive = true): Promise<DriveFile[]> {
  const allFiles: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "100",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive API error (${res.status}): ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  // If recursive, scan any subfolders too
  if (recursive) {
    const subfolders = allFiles.filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    for (const folder of subfolders) {
      const subFiles = await listFilesInFolder(accessToken, folder.id, true);
      allFiles.push(...subFiles);
    }
  }

  // Return only non-folder files
  return allFiles.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");

  return allFiles;
}

async function downloadAndParseFile(accessToken: string, file: DriveFile): Promise<Record<string, unknown>[]> {
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    // Google Sheets — export as CSV, then parse
    const url = `${DRIVE_API}/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Export failed for ${file.name} (${res.status})`);
    const text = await res.text();
    const workbook = XLSX.read(text, { type: "string" });
    const firstSheet = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
  }

  // Download binary file
  const url = `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Download failed for ${file.name} (${res.status})`);

  const buffer = await res.arrayBuffer();
  const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
  const firstSheet = workbook.SheetNames[0];
  // sheet_to_json preserves column boundaries — no CSV comma issues
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: "" });
}

async function importRows(rows: Record<string, unknown>[], fileName: string) {
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const batchId = `gdrive_${fileName.replace(/\.[^.]+$/, "").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}`;

  for (const row of rows) {
    try {
      // Get values by column name (case-insensitive lookup)
      const get = (keys: string[]): string => {
        for (const k of keys) {
          for (const [col, val] of Object.entries(row)) {
            if (col.toLowerCase().includes(k.toLowerCase()) && val !== "" && val != null) {
              return String(val).trim();
            }
          }
        }
        return "";
      };

      // Parse name
      let firstName = "";
      let lastName = "";
      const fullName = get(["agent_full_name", "full_name"]);
      if (fullName) {
        const parts = fullName.split(/\s+/);
        firstName = parts[0] || "";
        lastName = parts.slice(1).join(" ") || "";
      }
      if (!firstName) firstName = get(["first_name", "firstname"]);
      if (!lastName) lastName = get(["last_name", "lastname"]);

      // Parse email — take first if comma-separated
      const emailRaw = get(["emails", "email"]);
      const email = emailRaw ? emailRaw.split(",")[0].trim().toLowerCase() : null;

      // Must have email and valid email format
      if (!email || !email.includes("@")) { skipped++; continue; }
      if (!firstName && !lastName) { skipped++; continue; }

      const phone = get(["agent_phone_number", "phone", "mobile"]) || null;
      const stateVal = get(["state"]) || null;
      const cityVal = get(["city"]) || null;
      const brokerage = get(["agency_name", "brokerage", "company"]) || null;

      const totalTransactions = parseNumber(get(["closed_sales", "transactions"]));
      const totalVolume = parseNumber(get(["total_value", "volume", "total_volume"]));
      const totalVolumeCents = totalVolume ? BigInt(Math.round(totalVolume * 100)) : null;

      const data = {
        firstName,
        lastName,
        email,
        phone,
        state: stateVal,
        city: cityVal,
        brokerage,
        totalTransactions,
        totalVolumeCents,
        avgTransactions: totalTransactions ? Math.round(totalTransactions / 5) : null,
        avgVolumeCents: totalVolumeCents ? BigInt(Number(totalVolumeCents) / 5) : null,
        source: "google_drive" as const,
        importBatch: batchId,
      };

      const existing = await prisma.agent.findUnique({ where: { email } });
      if (existing) {
        await prisma.agent.update({
          where: { email },
          data: {
            ...data,
            emailVerifyStatus: existing.emailVerifyStatus,
            emailVerifiedAt: existing.emailVerifiedAt,
          },
        });
        updated++;
      } else {
        await prisma.agent.create({ data });
        imported++;
      }
    } catch {
      skipped++;
    }
  }

  return { imported, updated, skipped };
}

// parseCSVLine and buildColumnMap removed — using sheet_to_json instead

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const str = String(val).replace(/[$,\s]/g, "");
  const num = parseFloat(str);
  return isNaN(num) ? null : Math.round(num);
}
