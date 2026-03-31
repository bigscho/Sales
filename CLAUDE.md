# Grassfed Sales Dashboard — Session Handoff (March 30, 2026)

## Project
Next.js sales tracker at /home/user/Sales, deployed on Vercel (sales-puce-six.vercel.app).
Branch: `claude/recap-session-progress-CNZlu`
DB: Neon PostgreSQL via Prisma ORM.

## What's Working
- **Calendly webhook** → instant demo creation + Slack alert
- **GCal sync** every 10 min → reschedule detection + backup
- **Fireflies sync** every 30 min + webhook → auto show verification
- **Stripe webhook** → instant payment with MRR/one-time + new/returning classification
- **Financial feed** with clickable badges (revenue type, customer status) + match dropdown
- **Setter Scoreboard** page
- **Demos page**: day/week view, bulk select, side-by-side financials, no-flash refresh
- **Day locking** system
- **Dismissed events** (deleted demos stay deleted)
- **Slack**: real-time alerts (bookings, shows, payments) + daily recap (6pm ET) + CEO weekly (Sat 11am ET)
- **Dashboard**: New Revenue as headline KPI

## Env Vars on Vercel
- DATABASE_URL (Neon)
- CALENDLY_API_TOKEN
- GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_KEY
- STRIPE_WEBHOOK_SECRET
- FIREFLIES_API_KEY (comma-separated: Colin's,Mark's)
- SLACK_WEBHOOK_URL (team channel)
- SLACK_CEO_WEBHOOK_URL (CEO DM)

## Known Bugs to Fix
1. **Duplicate demos** — dedup fix pushed but confirm with fresh booking
2. **Calendly "Schofield" name** — webhook appends closer's last name to prospect
3. **Test $1 payments** — need to be deleted from DB

## Remaining Pillars (in order)
1. **Pillar 3: CEO Slack Deep Dive** — P&L summary, anomaly detection, cash flow week-over-week. User said "let's dive deeper when we do it"
2. **Pillar 4: UI Cleanup** — user will provide example UIs. Cleaner typography, mobile, cards
3. **Pillar 5: Admin/Auth** — no auth currently. Admin sees all, closers see their stuff, setters see bookings. Also filter returning revenue from sales team view
4. **Pillar 6: Weekly Video Coaching** — aggregate Fireflies transcripts, AI coaching highlights. User wants it "SICK" with Tuff Pigeon Doctor moments at the end
5. **Historical data import** — user will dump 2026 data "at the very end"

## Key Architecture Notes
- Import data in /src/app/api/import/route.ts has 133 static demos (historical)
- /api/setup POST wipes + re-imports (use sparingly)
- GCal sync uses service account JWT auth (no external libs)
- Fireflies API uses snake_case fields, date is millisecond timestamp
- Payment classification: revenueType (mrr/one_time/misc) + customerStatus (new/returning) are separate dimensions
- Both have override fields for manual correction
- Week starts on Monday (UTC)
