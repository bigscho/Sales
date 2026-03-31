# Grassfed Sales Dashboard — Session Handoff (March 31, 2026)

## IMPORTANT: Documentation Rules
- **Read `GrassfedSales.md` first** for full project context (schema, routes, architecture)
- **After making changes**, update both this file AND `GrassfedSales.md` if you:
  - Add/modify API routes
  - Change the Prisma schema
  - Add new Slack channels or notifications
  - Add new cron jobs
  - Change integrations (Calendly, Stripe, GCal, Fireflies)
  - Add new environment variables
- **Before ending a session**, update the "Known Bugs" and "Remaining Pillars" sections below

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
- **Slack #sales-team**: real-time alerts (bookings, shows, payments) + daily recap (6pm ET)
- **Slack #setter-tpds**: pigeon gamification (9AM/12PM/6PM + real-time tier crossings)
- **Slack #show-rate-tpds**: show notifications tagging setter + closer + weekly totals + Friday report
- **Slack #closer-tpds**: close/payment notifications tagging closer + revenue totals
- **Reschedule handling**: Calendly reschedules update booking date in-place (not mark+recreate)
- **Show rate formula**: uses shows/(shows+noShows) everywhere — pending excluded
- **Booking feed**: shows all bookings created today across all weeks
- **Team page**: Slack user ID field on add/edit forms for real @mentions
- **Video game tier system**: COMMON/UNCOMMON/RARE/LEGENDARY pigeon tiers
- **Slack CEO DM**: weekly briefing (Sat 11am ET)
- **Dashboard**: New Revenue as headline KPI
- **Setter pigeon gamification**: daily score tracking, tier crossings (4/9/12), points system

## Env Vars on Vercel
- DATABASE_URL (Neon)
- CALENDLY_API_TOKEN
- GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_KEY
- STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY
- FIREFLIES_API_KEY (comma-separated: Colin's,Mark's)
- SLACK_WEBHOOK_URL (#sales-team)
- SLACK_CEO_WEBHOOK_URL (CEO DM)
- SLACK_SETTER_WEBHOOK_URL (#setter-tpds)
- SLACK_SHOWRATE_WEBHOOK_URL (#show-rate-tpds)
- SLACK_CLOSER_WEBHOOK_URL (#closer-tpds)

## Known Bugs to Fix
1. **Calendly "Schofield" name** — webhook strips known closer last names but edge cases may remain with new closers

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
