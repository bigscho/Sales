import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const CE = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const PK = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";
function b64u(b) { return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function jwt() { const n = Math.floor(Date.now() / 1000); const h = b64u(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))); const p = b64u(Buffer.from(JSON.stringify({ iss: CE, scope: "https://www.googleapis.com/auth/calendar.readonly", aud: TOKEN_URL, iat: n, exp: n + 3600 }))); const i = `${h}.${p}`; const s = crypto.createSign("RSA-SHA256"); s.update(i); s.end(); return `${i}.${b64u(s.sign(PK))}`; }
const tr = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt() }) });
const tok = (await tr.json()).access_token;

const unattrib = await prisma.booking.findMany({
  where: {
    createdAt: { gte: new Date("2026-05-25T00:00:00Z"), lt: new Date("2026-06-01T00:00:00Z") },
    setterId: null,
    source: { in: ["calendly_webhook", "manual", "gcal_sync"] },
  },
  include: { demo: true },
  orderBy: { createdAt: "asc" },
});

console.log(`${unattrib.length} unattributed bookings this week:\n`);
for (const b of unattrib) {
  console.log(`Booking: ${b.id}`);
  console.log(`  Prospect: ${b.prospectName} <${b.prospectEmail || "(no email)"}> ${b.prospectPhone || ""}`);
  console.log(`  Demo: ${b.demoDate.toISOString()} | source=${b.source} | createdAt=${b.createdAt.toISOString()} | status=${b.demo?.status}`);
  console.log(`  calendarEventId: ${b.calendarEventId}`);

  if (b.calendarEventId) {
    const m = b.calendarEventId.match(/^(.+)_(Colin|Mark)$/);
    if (m) {
      const [, eventId, closer] = m;
      const cal = closer === "Colin" ? "colin@grsfd.co" : "mark@grsfd.co";
      const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(cal)}/events/${eventId}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (res.ok) {
        const e = await res.json();
        const desc = e.description || "";
        const bookedBy = (desc.match(/Booked by:\s*(.+)/i) || [])[1]?.trim();
        const phone = (desc.match(/Phone Number:\s*(.+)/i) || [])[1]?.trim();
        console.log(`  GCal summary: ${e.summary}`);
        console.log(`  GCal start: ${e.start?.dateTime || e.start?.date}`);
        console.log(`  GCal Booked by: ${bookedBy || "(NOT IN DESCRIPTION)"}`);
        console.log(`  GCal phone: ${phone || "(none)"}`);
        // First 500 chars of description so user can see context
        console.log(`  GCal desc preview: ${desc.slice(0, 400).replace(/\n/g, " | ")}`);
      } else {
        console.log(`  GCal lookup failed: ${res.status}`);
      }
    }
  }
  console.log("");
}
await prisma.$disconnect();
