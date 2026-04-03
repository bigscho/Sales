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
Primary dev branch: `claude/setup-project-access-dGk7x` (merged all work from resume-session-JU9mq)
DB: Neon PostgreSQL via Prisma ORM.

## Debug Endpoint
`GET /api/debug` — query the DB directly to investigate booking issues:
- `?name=andrea` — find bookings by prospect name (case-insensitive)
- `?email=foo@bar.com` — find bookings by email
- `?all_dismissed=true` — list all dismissed events
- `?all_no_shows=true` — list all no-show/rescheduled demos
- `?calendar_event_id=xxx` — look up by specific calendarEventId
- Always returns summary stats (total bookings, demos, dismissed, status counts)

## Enterprise Claude Permissions Needed
If using Enterprise Claude (without MCP tools), it needs:
- **Read access to Vercel env vars** or `.env.local` — the GCal service account credentials, DB URL
- **Ability to run `npx prisma studio`** or hit the debug endpoint above to query the DB
- **Access to Google Calendar API** responses — to see what events look like for specific attendees
- Without these, it can write code fixes but cannot verify if they work for specific records

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
- **Slack #setter-daily-verify**: daily verification (10:05 PM ET weekdays) — per-setter WTD stats + review link + CEO summary
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
- **Dynamic closer name stripping**: pulls closer last names from DB + known variants (no more hardcoded list)
- **Self-booking attribution**: non-setter bookers auto-created as excludeFromLeaderboard TeamMembers (real name, excluded from leaderboards)
- **Dashboard setter leaderboards**: medal-style leaderboard cards replace plain setter table (shared component with scoreboard)
- **Demos setter filter**: `/demos?weekId=X&setter=Y` filters to specific setter's demos
- **Setter verification system**: `/verify?weekId=X&setter=Y` read-only confirmation UI — setters confirm credit or flag issues, flags route to CEO DM, morning nudge for non-confirmers
- **CEO verification dashboard**: `/verify/admin?weekId=X` — per-setter summary, resolve flags, add missing demos, Lock Week button
- **Payroll gate**: payroll generation blocked until week is verified via Lock Week
- **Auth**: PIN-based login with role-based middleware — setters see verify+scoreboard, closers see demos+deals, admin sees everything

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
- SLACK_DATAVERIFICATION_WEBHOOK_URL (#setter-daily-verify)
- SESSION_SECRET (random string for JWT signing)

## Outbound Console (In Progress)

### What's Built (Phase 1 — DEPLOYED TO PRODUCTION)
- **Prisma schema**: Agent, OutboundCampaign, OutboundPush, ScheduledPush models added
- **Agent database**: 249,151 real estate agents imported from 48 state XLSX files via Google Drive
- **`/api/agents`**: GET with pagination + filters (state, city, production range, contacted status, search), POST, PATCH
- **`/api/agents/import`**: Bulk CSV import with upsert by email, handles homes.com column format
- **`/api/agents/gdrive`**: Google Drive auto-import using service account. Downloads XLSX files, parses with SheetJS, upserts by email. Supports batch import, single file, and wipe+reimport
- **`/agents` page**: Filterable table with checkboxes, CSV upload dialog, Google Drive import button, bulk action bar (push buttons placeholder)
- **Sidebar**: Agents + Outbound nav items added
- **Data cleaning on import**:
  - Names: agent_full_name split into first/last, Title Case normalized, non-first-names (initials, company names) replaced with "there" for "Hey there" outreach
  - Phones: normalized to +1XXXXXXXXXX format for GHL/SMS
  - Emails: first email taken if comma-separated, validated (must contain @)
  - Volumes: handles $1.2M / $500K suffixes, stored in cents
  - Cities/states/brokerages: Title Case normalized
- **Fields stored**: firstName, lastName, email, phone, city, state, brokerage, licenseNumber, yearsExperience, homeTypes, mlsNumber, totalTransactions, totalVolumeCents, avgTransactions, avgVolumeCents, contactCount, lastContactedAt, lastContactedChannel
- **Google Drive setup**: Service account `calendar-tracking@grassfed-calendar-tracking.iam.gserviceaccount.com` has access to Shared Drive folder `1oUm4jzKSLpNKjr7qsntwSd8oApn1Wswa` (Raw States). Google Drive API enabled on project 957665194986

### API Keys Collected (in .env locally, need to add to Vercel)
- `SMARTLEAD_API_KEY` — confirmed working, 180 campaigns visible
- `OMNI_VERIFIER_API_KEY` — for email validation before Smartlead push
- `GHL_API_KEY_1` + `GHL_API_KEY_2` — Private Integration bearer tokens for 2 rented sub-accounts

### What's Next (Phase 2)
1. **Data import decision**: DECIDED — Google Drive auto-pull. Endpoint built at `/api/agents/import-drive`. User shared "Raw States" folder (folder ID: `1oUm4jzKSLpNKjr7qsntwSd8oApn1Wswa`) with the service account email. All 50 states in one folder. Google auth helpers extracted to `src/lib/google-auth.ts`.
2. **Deploy Phase 1**: Push dev branch to production, run Prisma migration, add env vars to Vercel
3. **Smartlead push endpoint**: `/api/outbound/push` — format fields (Email, first_name, City case-sensitive), call Smartlead API
4. **Email validation gate**: `/api/agents/verify` — call Omni Verifier before Smartlead push, cache results
5. **GHL push endpoint**: Use Private Integration bearer tokens, create contacts + trigger workflow
6. **Outbound page**: Campaign cards with analytics, push history
7. **Slack #outbound-tpds**: Notifications when batches get pushed
8. **Scheduled pushes**: Automated recurring pushes with filter criteria

### Smartlead Field Mapping (for push)
| Agent DB | Smartlead | Notes |
|---|---|---|
| email | Email | Case-sensitive, required |
| firstName | first_name | Email copy variable |
| city | City | Case-sensitive |
| lastName | last_name | Lead details |
| phone | phone | Lead details |
| state | state | Lead details |
| brokerage | company_name | Lead details |

### GHL Integration Notes
- Using Private Integration OAuth tokens (not legacy API keys)
- Scopes: contacts.readonly, contacts.write, workflows.readonly, locations.readonly
- workflows.write was not available — adding to workflow done via contacts API
- 2 rented A2P-approved sub-accounts for SMS sequences

### Data Source
- 220K real estate agents from homes.com (scraped)
- 50 Google Drive folders, one per state
- Fields: agent_full_name, emails, agent_phone_number, agency_name, city, state, closed_sales, total_value, price_range, average_price, lisence_number, Years_Experience
- Could grow to 2M with future data purchases
- Refreshed lists from same provider — import updates existing records by email match

## Known Bugs to Fix
1. **Calendly closer name stripping** — FIXED: now dynamic from DB + known variants. No longer hardcoded
2. **Andrea Reeves-Witherspoon invisible** — marked no_show, GCal invite dragged to next Thursday, sync returns 0 updated. She's not visible in UI on any date. Needs DB investigation via `/api/debug?name=andrea`. Likely causes: (a) calendarEventId format mismatch preventing lookup, (b) booking in DismissedEvent table, (c) weekId pointing to nonexistent/wrong week. Four code fixes already applied in gcal/route.ts but her specific record needs manual investigation.

## Remaining Pillars (in order)
1. **Pillar 3: CEO Slack Deep Dive** — P&L summary, anomaly detection, cash flow week-over-week. User said "let's dive deeper when we do it"
2. **Pillar 4: UI Cleanup** — user will provide example UIs. Cleaner typography, mobile, cards
3. **Pillar 5: Admin/Auth** — no auth currently. Admin sees all, closers see their stuff, setters see bookings. Also filter returning revenue from sales team view
4. **Pillar 6: Weekly Video Coaching** — aggregate Fireflies transcripts, AI coaching highlights. User wants it "SICK" with Tuff Pigeon Doctor moments at the end
5. **Historical data import** — user will dump 2026 data "at the very end"

## Backlog (lower priority improvements)
- **Day-focused dashboard view** — main dashboard could have a "today" mode showing today's demos + cash instead of full week
- **Deals page simplification** — feels redundant with demos page financial feed. Consider making it admin-only or merging
- **Setter confirmation push** — daily Slack nudge for setters to confirm their bookings showed
- **Closer confirmation push** — nudge closers to confirm show rate
- **Booking feed vertical layout** — currently vertical list in right column, could be improved with more detail
- **Booking feed closer assignment** — closer is shown but not always assigned at booking time
- **30 old demos with null setter** — historical demos from before March 9 have no setter attribution, affects all-time scoreboard

## Key Architecture Notes
- Import data in /src/app/api/import/route.ts has 133 static demos (historical)
- /api/setup POST wipes + re-imports (use sparingly)
- GCal sync uses service account JWT auth (no external libs)
- Fireflies API uses snake_case fields, date is millisecond timestamp
- Payment classification: revenueType (mrr/one_time/misc) + customerStatus (new/returning) are separate dimensions
- Both have override fields for manual correction
- Week starts on Monday (UTC)
