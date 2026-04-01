import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getGoogleAccessToken } from "@/lib/google-auth";
import * as XLSX from "xlsx";

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
export async function POST(request: NextRequest) {
  try {
  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  const fileFilter = body.fileName as string | undefined; // optional: import only one file

  const { clientEmail, privateKey } = getCredentials();
  const accessToken = await getGoogleAccessToken(clientEmail, privateKey, DRIVE_SCOPES);

  const allFiles = await listFilesInFolder(accessToken, FOLDER_ID);

  // Filter to spreadsheet/CSV files only, and optionally by name
  const importableFiles = allFiles.filter((f) => {
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

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      filesToImport: importableFiles.map((f) => f.name),
      totalFiles: importableFiles.length,
    });
  }

  const results = {
    filesProcessed: 0,
    totalImported: 0,
    totalUpdated: 0,
    totalSkipped: 0,
    fileResults: [] as { name: string; imported: number; updated: number; skipped: number; error?: string }[],
  };

  for (const file of importableFiles) {
    try {
      const csvText = await downloadFileAsCSV(accessToken, file);
      if (!csvText || csvText.trim().length === 0) {
        results.fileResults.push({ name: file.name, imported: 0, updated: 0, skipped: 0, error: "Empty file" });
        continue;
      }

      const { imported, updated, skipped } = await importCSV(csvText, file.name);
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

async function downloadFileAsCSV(accessToken: string, file: DriveFile): Promise<string> {
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    // Google Sheets — export as CSV directly
    const url = `${DRIVE_API}/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Export failed for ${file.name} (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.text();
  }

  // Regular file (XLSX, CSV) — download as binary
  const url = `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Download failed for ${file.name} (${res.status}): ${text.slice(0, 200)}`);
  }

  // If it's an Excel file, parse with SheetJS and convert to CSV
  if (
    file.name.endsWith(".xlsx") || file.name.endsWith(".xls") ||
    file.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.mimeType === "application/vnd.ms-excel"
  ) {
    const buffer = await res.arrayBuffer();
    const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
    const firstSheet = workbook.SheetNames[0];
    return XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheet]);
  }

  // Plain CSV/text
  return res.text();
}

async function importCSV(csvText: string, fileName: string) {
  const lines = csvText.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { imported: 0, updated: 0, skipped: 0 };

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const colMap = buildColumnMap(headers);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const batchId = `gdrive_${fileName.replace(/\.[^.]+$/, "").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}`;

  for (let i = 1; i < lines.length; i++) {
    try {
      const cols = parseCSVLine(lines[i]);
      if (cols.length < 3) { skipped++; continue; }

      // Parse name
      let firstName = "";
      let lastName = "";
      if (colMap.fullName !== -1 && cols[colMap.fullName]) {
        const parts = cols[colMap.fullName].trim().split(/\s+/);
        firstName = parts[0] || "";
        lastName = parts.slice(1).join(" ") || "";
      }
      if (colMap.firstName !== -1 && cols[colMap.firstName]) firstName = cols[colMap.firstName].trim();
      if (colMap.lastName !== -1 && cols[colMap.lastName]) lastName = cols[colMap.lastName].trim();

      // Parse email — take first if comma-separated
      let email: string | null = null;
      if (colMap.email !== -1 && cols[colMap.email]) {
        email = cols[colMap.email].split(",")[0].trim().toLowerCase() || null;
      }

      if (!email) { skipped++; continue; }
      if (!firstName && !lastName) { skipped++; continue; }

      const phone = colMap.phone !== -1 ? cols[colMap.phone]?.trim() || null : null;
      const stateVal = colMap.state !== -1 ? cols[colMap.state]?.trim() || null : null;
      const cityVal = colMap.city !== -1 ? cols[colMap.city]?.trim() || null : null;
      const brokerage = colMap.brokerage !== -1 ? cols[colMap.brokerage]?.trim() || null : null;

      const totalTransactions = colMap.transactions !== -1 ? parseNumber(cols[colMap.transactions]) : null;
      const totalVolume = colMap.volume !== -1 ? parseNumber(cols[colMap.volume]) : null;
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
    } else if ((char === "," || char === "\t") && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

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
    firstName: find(["first_name", "first name", "firstname"]),
    lastName: find(["last_name", "last name", "lastname"]),
    email: find(["emails", "email"]),
    phone: find(["agent_phone_number", "phone", "mobile", "cell"]),
    state: find(["state"]),
    city: find(["city"]),
    brokerage: find(["agency_name", "brokerage", "company", "office"]),
    transactions: find(["closed_sales", "transaction", "closed_sale"]),
    volume: find(["total_value", "volume", "total_volume", "sales volume"]),
  };
}

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const str = String(val).replace(/[$,\s]/g, "");
  const num = parseFloat(str);
  return isNaN(num) ? null : Math.round(num);
}
