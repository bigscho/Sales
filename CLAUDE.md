# Grassfed Sales Dashboard — Session Handoff (May 18, 2026)

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
**Production branch: `main`** — Vercel auto-deploys from this.
DB: Neon PostgreSQL via Prisma ORM.

## CRITICAL: Branch Rules
1. **Always branch from `origin/main`** — run `git fetch origin main` first
2. **Never branch from other `claude/*` branches** — they go stale fast
3. **Before starting work**, verify your branch is up to date with main: `git log --oneline origin/main..HEAD` should only show YOUR commits
4. **Merge to main when done** — don't leave work stranded on feature branches
5. **Delete stale branches** — if a `claude/*` branch is >1 week old and merged, delete it

## Debug Endpoint
`GET /api/debug` — query the DB directly to investigate booking issues:
- `?name=andrea` — find bookings by prospect name (case-insensitive)
- `?email=foo@bar.com` — find bookings by email
- `?all_dismissed=true` — list all dismissed events
- `?all_no_shows=true` — list all no-show/rescheduled demos
- `?calendar_event_id=xxx` — look up by specific calendarEventId
- Always returns summary stats (total bookings, demos, dismissed, status counts)

## Setter Attribution Audit
`/api/admin/setter-audit` — finds and corrects bookings where the Calendly "Booked by" setter disagrees with `setterId` (caused by a pre-fix bug where rebookings through a different setter's link didn't overwrite the original setter on dedup-matched records).
- `GET ?since=YYYY-MM-DD&limit=100` → dry-run: returns mismatched rows with current vs Calendly setter
- `POST { bookingIds: ["..."] }` → fix specific bookings, audit-logged as `setter_audit_backfill`
- `POST { applyAll: true, since, limit }` → fix every detected mismatch in window

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
- **CEO Financial Dashboard** (Phase 1): `/ceo`, `/ceo/review`, `/ceo/pnl`, `/ceo/transactions` — Mercury API sync, Amex CSV import, auto-categorization with learning merchant mappings (60+ vendors seeded), weekly review workflow, monthly P&L with MoM comparison, live MRR tracker with churn flagging, monthly close. Admin-only sidebar section. Needs `MERCURY_API_KEY` env var + `POST /api/ceo/seed` to initialize categories.

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
3. **Fireflies false shows** — FIXED (Apr 3): 5-layer verification now checks summary_status, silent_meeting, sentence count (≥6 substantive), speaker count (≥2), and content relevance (business keyword match). 9 false shows identified for week of Mar 30 — user manually correcting.
4. **Rebooking setter attribution** — FIXED (Apr 27): when a prospect rebooked through a different setter's Calendly link, the webhook's dedup matched the existing booking but never overwrote `setterId`, so credit stayed with the original setter (e.g., Calman Lee booked by Heidi, rebooked by Ming → still attributed to Heidi). Webhook now re-resolves setter on every `invitee.created` and updates if changed; the change is audit-logged as `calendly_setter_reassigned`. Backfill via `/api/admin/setter-audit` (see above).
5. **Scoreboard hiding gcal_sync bookings + silent Slack failures** — FIXED (May 18): the Calendly webhook subscription had drifted to point at a stale Vercel preview hostname (`sales-puce-six.vercel.app`) instead of the canonical `barn.grsfd.ai` alias, so May 16–18 demos only landed via the 10-min `gcal_sync` backup. The scoreboard route's source filter excluded `gcal_sync`, and the two Slack-post `catch` blocks in the Calendly webhook swallowed errors silently — net effect was a blank leaderboard and silent #sales-team / #setter-tpds with no surfacing of the failure. Repair: re-pointed Calendly subscription at `barn.grsfd.ai`, reconciled 50 historical setter-attributed `gcal_sync` rows to `source='manual'` (all 8 affected weeks were `draft`/unconfirmed so no payroll impact), and shipped PR #1 to (a) include `gcal_sync` in the scoreboard's allowed sources and (b) replace `catch { /* … */ }` with `console.error` so future delivery failures show up in `vercel logs`.

## Branch Hygiene
- **Production branch is `main`** — all feature branches must be created from `origin/main`
- **Never chain branches** — branching from `claude/foo` instead of `main` causes drift
- **Merge back to main promptly** — don't leave work on feature branches for days
- **Delete old branches after merge** — stale `claude/*` branches cause confusion across sessions

## What Was Built (Apr 6-7 session)
- **Expenses page overhaul** (`/ceo/expenses`): Merged redundant Transactions page into Expenses. Added checkboxes + Select All per column, bulk action bar, re-categorize dropdown on ALL transactions, free-form notes input, natural language quick input per column
- **Deleted `/ceo/transactions`** page and sidebar link (redundant with Expenses)
- **Cost purpose system**: Added `costPurpose` field (cogs | cac | overhead) to `FinancialCategory` schema. Each expense category gets a purpose tag that drives unit economics
- **Expenses UI**: COGS/CAC/Overhead as primary badges on each transaction. Payroll is a separate checkbox toggle (not a classification). Clickable summary cards drill down to filtered view. Filters: All | Needs Review | COGS | CAC | Overhead | Payroll | Personal
- **"Configure Cost Types" panel**: Inline on Expenses page — toggle each category between COGS/CAC/Overhead with one click
- **3 payroll sub-categories**: Payroll - Sales (CAC), Payroll - Fulfillment (COGS), Payroll - Misc (Overhead)
- **PATCH `/api/ceo/categories`**: Update costPurpose per category
- **Seed defaults**: Email Infra/Automation/Data = COGS, Internal Marketing/Verification/CRM = CAC, Software/Communication/Accounting/Education/Fees = Overhead. GoDaddy moved from Email Infra to Internal Marketing (CAC). OmniVerifier = COGS (used for clients)
- **Metrics plan**: `METRICS-PLAN.md` in project root — 4-phase roadmap for unit economics

### Cost Purpose Classifications (confirmed with user)
| Category | Purpose | Notes |
|---|---|---|
| Email Infrastructure | COGS | Smartlead, PuzzleInboxes = client campaigns |
| Automation | COGS | Zapier/Make flows for client delivery |
| Data | COGS | BatchData/PropertyShark for client campaigns |
| Verification | COGS | OmniVerifier for client email verification |
| Internal Marketing | CAC | HighLevel, Calendly, Webflow, Wistia = lead gen |
| CRM | CAC | Airtable for internal sales tracking |
| Software | Overhead | ClickUp, Fireflies, Anthropic, Docusign etc |
| Communication | Overhead | Slack, Loom |
| Accounting | Overhead | QuickBooks |
| Education | Overhead | Hormozi, Affirm |
| Fees | Overhead | Bank/processing fees |
| All setter/closer payroll | CAC | Their job is acquisition |
| Onboarding team payroll | COGS | Client delivery |
| GoDaddy | CAC | Own domains, not client infra |

### Open Questions for Next Session
1. **COGS/CAC accuracy timing problem**: Expense charges don't all land in the same month as the service. COGS and CAC totals for a given month will be incomplete until all bills come in. The only truly real-time trustworthy metrics are revenue-based (cash collected, MRR, new revenue). Cost-based metrics (CAC, gross margin, contribution margin) are only accurate after monthly close. **Possible approaches**: (a) only show cost metrics for closed/past months, (b) show current month with a "provisional" flag, (c) use trailing averages (last 3 months of COGS / last 3 months of customers = smoothed CAC). Need to decide before building the metrics page.

2. **Payments that cross month boundaries**: Some payments go out in April for March work (e.g., Danielle, Belayneh, Ming, Venmo). Should we attribute expenses to the month they're paid or the month they're for? This affects P&L accuracy. Options: (a) use transaction date as-is (simple, matches bank statements), (b) let user override the "effective month" on specific transactions, (c) use accrual-basis with a `serviceMonth` field. Same question applies to revenue — if a client pays in April for March service, which month gets credit?

3. **Revenue method consistency across sales pages**: The CEO revenue dashboard pulls from Stripe/Payment table. The main sales dashboard pulls from Deal.month1Cash + Payment.amountCents. Need to verify these are consistent and that changes to the CEO financial system haven't broken the sales-facing KPIs (cash collected, cash/booking, cash/show, cash/close on the main dashboard).

### Post-deploy required
- Hit `POST /api/ceo/seed` to apply costPurpose defaults to existing categories
- User should review/adjust via "Configure Cost Types" on Expenses page
- Payroll transactions need payroll checkbox checked + category assigned on Expenses page

## What Was Built (Apr 3 session)
- **Closer verification cron**: `/api/slack/closer/verify` at 8 PM ET → `#closer-tpds`, per-closer pending demos + WTD show rate + link to demos page
- **Setter verification env var fix**: `SLACK_DATAVERIFICATION_WEBHOOK_URL` (was mismatched as `SLACK_VERIFY_WEBHOOK_URL`)
- **Fireflies show detection overhaul**: 5-signal verification in both sync cron and webhook (summary_status, silent_meeting, sentence count, speaker count, content relevance keywords)
- **Smartlead import**: cherry-picked from orphaned branch — API client (`src/lib/smartlead.ts`), import route, UI page (`/smartlead`)
- **Admin lookup**: cherry-picked — `/api/admin/lookup` diagnostic endpoint
- **Calendly guard**: cherry-picked — invitee.canceled only cancels pending demos

## Remaining Pillars (in order)
1. **Metrics Phase 1: Sales Efficiency** — NO schema changes needed. Build `GET /api/ceo/sales-efficiency` + `/ceo/metrics` page. Revenue per setter, cost per show/close, setter/closer ROI, outbound ROI, deal cycle time. Add trailing 30/60/90 day time dimensions. See `METRICS-PLAN.md` for full spec.
2. **Metrics Phase 3: Customer Model** — New `Customer` Prisma model. Backfill from existing Deal/Payment data. Enables LTV, LTV:CAC ratio, per-client P&L, cohort analysis, payback period. See `METRICS-PLAN.md`.
3. **Metrics Phase 4: MRR/Churn** — Add `reason` field to MrrEvent, support expansion/contraction events. Enables NRR, churn reasons, avg customer lifespan.
4. **Pillar 3: CEO Slack Deep Dive** — P&L summary, anomaly detection, cash flow week-over-week. User said "let's dive deeper when we do it"
5. **Pillar 4: UI Cleanup** — user will provide example UIs. Cleaner typography, mobile, cards
6. **Pillar 5: Admin/Auth** — no auth currently. Admin sees all, closers see their stuff, setters see bookings. Also filter returning revenue from sales team view
7. **Pillar 6: Weekly Video Coaching** — aggregate Fireflies transcripts, AI coaching highlights. User wants it "SICK" with Tuff Pigeon Doctor moments at the end
8. **Historical data import** — user will dump 2026 data "at the very end". Includes demos/sales data AND financial backfill via `/api/ceo/backfill` (Stripe payments by date range with subscription detection, refund tracking, and confidence scoring). March 2026 already backfilled and reconciled.

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
