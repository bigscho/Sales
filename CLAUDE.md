# Grassfed Sales Dashboard — Session Handoff (May 28, 2026)

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

## CRITICAL: Setter Attribution Model — read before touching anything attribution-related
- **One Calendly link, owned by the CEO.** Setters do NOT have individual Calendly links and there are NO per-setter UTM tags.
- Setters give themselves credit by typing their name into a free-text **"Booked by"** field on the Calendly intake form.
- Wrong / missing / typo'd names are common. Operators correct these via `manual_backfill` audit-logged updates.
- **Automation MUST NOT overwrite manual setter corrections.** Never re-parse the description on a routine cron poll of an already-known event — that silently reverts operator backfills. See `sync/gcal/route.ts` comment at the compositeId-match branch. PR #6 enforced this; do not regress it.
- For the activity counter (scoreboard "new bookings this week"), the source of truth is `Booking.bookedAt`, NOT `createdAt`.

## CRITICAL: Sales money definition (Aug 2026) — do not regress
- **Every cash figure in sales views is UPFRONT CASH ONLY**: charges within 24h of a deal's first payment, first-time clients only, net of refunds — `dealUpfrontCents()` in `src/lib/cash.ts` is the single source. Renewals, reorders, later charges, and "returning revenue" are deliberately NOT displayed anywhere (Colin: "overall revenue is easy to look at on Stripe; this is the sales dashboard"). Closer commission uses the same rule (payroll.ts `UPFRONT_WINDOW_HOURS`). Never re-add total/returning revenue to dashboard, feeds, day locks, or Slack recaps.
- Amendment (Colin, Aug 13): the scoreboard closer board's Cash Collected column IS team-visible cash — the one deliberate exception to hiding money from closers/setters. See "Closer board Cash Collected column" below.
- Exception: UNMATCHED payments stay visible in the demos financial feed — they're the match work-queue, not revenue display.
- `Payment.isMonth1` is hardcoded true on every insert — meaningless, never use it.

## CRITICAL: Closer contract tracking (Aug 2026) — Will Farrell's 1099 comp
- Active closers: Colin (`closer-colin`), Matthew (`closer-matthew`), **Will Farrell (`closer-will`)**. Mark departed (`closer-mark`, isActive=false — do NOT re-add his calendar to any sync list; it 404s).
- **Will is the only comped closer** — comp config lives in `CLOSER_COMP` (src/lib/payroll.ts), keyed by TeamMember id: 16% fed / 25% self-sourced weekly commission on new-business cash collected, $3,500 monthly base with volume floor (<20 closes → $0) + quality floor (fed close rate <25% → −$200/pt, floor $1,500, needs 15+ fed demos showed), 60-day refund clawback. Colin/Matthew have no entry → tracked, unpaid.
- **`leadSource` (fed | self_sourced)** on Booking + Deal is FIXED AT BOOKING (§4.6): self_sourced only when "Booked by" names the closer hosting the demo. Reschedule successors must always inherit the original row's leadSource — never re-derive it from the rescheduler. Ambiguity defaults to fed (§4.12(b) protects the company). Manual corrections via the FED/SELF toggle on /demos (audit `lead_source_update`); demo-side changes sync the linked deal.
- Every code path that creates a Deal must copy `leadSource` from the demo's booking (stripe webhook autoMatchAndLink, /api/payments matchToDemoId, /api/reconcile, /api/deals POST).
- Fireflies show-verification: Colin's API key is a TEAM ADMIN key that returns org-wide transcripts — new closers need only a Fireflies workspace seat, no env change.
- **Closer view scoping (non-admin closers)**: closers DOUBLE AS SETTERS, so they get full operational visibility (ALL demos, Bookings Today, scoreboard) but ZERO company revenue: demos-page financial feed + day-lock cash + week-accordion cash hidden; /api/deals returns only their own deals and no unlinked-payments feed; dashboard + /api/kpis blocked ("/" redirects them to /demos). Demo DELETE + day lock/unlock are admin-only server-side; pages render read-mostly for closers (status + FED/SELF toggle only). Audit `performedBy` = session name — do not regress to hardcoded "admin".
- **Cross-booking setter credit**: a closer's name in "Booked by" sets `setterId` to that closer (closers double as setters; self-sourced bookings credit them as their own setter). Never auto-create a setter TeamMember row for a closer's name.
- **Shadowing rule (do not regress)**: the PRIMARY closer is the Calendly event-type OWNER. The webhook resolves closer from the event type's profile (NOT `event_memberships[0]` — co-hosts/shadowers appear there). GCal sync must skip events the scanned closer doesn't host (`isHostedByOtherCloser`: organizer is a different @grsfd.co account, or the summary names another closer) — guest copies of shadowed demos otherwise create duplicates and hijack calendarEventIds. Never attribute a demo from the gcal composite-id suffix; it only proves whose calendar the event was seen on.
- **Pre-demo nurture emails live in grassfedlite** (Railway, admin.grsfd.ai `/api/webhooks/calendly`, org-scoped Calendly webhook → `demo_sequences`/`demo_emails`, sent via Resend every 15 min). NOT in this repo, NOT Calendly Workflows. Event-type filtered (farm|just|demo|e-mailers|setup) since 2026-08-12 — new closers are covered automatically, no wiring.

## CRITICAL: Immutable Week History (Aug 2026) — do not regress
- **A booking row never leaves its week and `bookedAt` is NEVER bumped after row creation.** A real reschedule/rebook freezes the old row (`supersededAt` set; pending demo → `rescheduled`; showed/no_show/cancelled untouchable) and creates a successor row (`rescheduledFromId` link) in the new week, credited to the most-recent setter. Same-event GCal drags of still-pending demos move in place without touching `bookedAt`.
- All dedup matchers filter `supersededAt: null`. Never mutate a superseded row — it is frozen history and the reason past weeks' numbers no longer restate.
- The "as-booked" number (dashboard + scoreboard) = rows `createdAt` in the period; it is the immutable reference and must stay untouched by any future logic.
- Full explanation in `GrassfedSales.md` → "Immutable Week History" + "Setter Attribution — How It Actually Works".

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
- **/economics — Sales Economics page** (Aug 13, admin-only): Colin's headline metrics — cash/booked call, cash/show, cash/close, total cash collected — weekly/monthly/all-time. LANDED basis for ALL headline metrics (Colin, Aug 13 pm: "shows new revenue THIS WEEK vs almost hiding it because the demo was last week") — per-X = cash landed in the period (payroll's `isCommissionable` rule, matches scoreboard + commission) ÷ that period's own activity (calls/shows by demoDate, closes by closedAt, same as the scoreboard); numerator and denominator are different cohorts BY CHOICE, the trade-off for never hiding late-collected money and never restating. Cohort Cash (demos' eventual upfront via `dealUpfrontCents`, restates upward) is kept as a reference COLUMN in the history table only. Setter cash = landed payments attributed via deal→demo→booking→setter (demo-less organic deals → "Organic (no demo)" line); the setter table sums to the landed total. Closes have their own receipts table (closed-won by closedAt, demo-outside-period flagged). Period history table (click a row to inspect), receipts per period: per-setter cohort economics (cash/call + cash/show per setter; excludeFromLeaderboard bookers fold into "Other", no-setter into "Unattributed" so the table always sums to the total; show rate uses the app-wide shows/(shows+noShows+cancelled) definition), every demo row in the cohort, every landed payment with counted/excluded verdicts. **Receipts layout (Colin, Aug 13 pm: "every transaction shouldn't be in there")**: each receipts block is a collapsible ReceiptSection card; only "New revenue landed" is open by default and it shows ONLY counted rows + refunds + unmatched-new warnings; excluded/reorder/returning-unlinked rows fold behind a "Show N excluded ($X)" toggle. The money-in reconciliation line stays visible so the total still proves out. The by-week methodology paragraph folds behind a "How this math works" details. Do not flatten these back into always-open tables. `/api/economics?granularity=` for the series, `?detail=true&start&end` for receipts. Setter cash is deliberately admin-only (Colin, Aug 13) — do NOT surface setter cash on team views. **Unmatched-NEW-cash surfacing (Colin, Aug 13: "surface it so we don't lose it silently")**: dealId-null payments with effective customerStatus "new" render as ONE slim strip (Colin, Aug 13: the big banner read as a false alarm) — amber ONLY when the selected period has unmatched new cash, gray otherwise, all-time backlog as an aside, "Reconcile →" button opens the drawer — plus a warning line on the landed tile + amber rows in the landed receipts; returning-status unlinked payments show grayed for full money-in reconciliation ("Total money in = counted new · reorders/excluded · unlinked"). Found $43.7k of historical unmatched new cash at launch (much of it pre-tracking-era or Farm subs with no demo). **Reconcile drawer (Aug 13)**: "Reconcile transactions" button on the receipts header → right slide-over listing EVERY transaction in the period with its verdict; per-row "New revenue"/"Not new"/"Auto" buttons write `Payment.upfrontOverride` (include|exclude|null) via the audited /api/payments PATCH, and unlinked rows get a search-any-week demo matcher (`/api/economics?demoSearch=` — late cash usually belongs to a PAST demo; matching it makes that week's cohort cash/show right) plus an "organic — no demo" path (`organicCloserId` on /api/payments PATCH: creates a demo-less closed_won deal in the payment's week under the chosen closer, leadSource fed by default, upfrontOverride=include). Organic cash flows to landed totals + closer scoreboard + commission but deliberately stays OUT of cohort per-call/show metrics — no call produced it. `upfrontOverride` is the HUMAN FINAL WORD: checked first (after no-deal/failed) by payroll `commissionExclusionReason` AND `cash.dealUpfrontCents`, so one override moves economics, scoreboard cash, and commission identically (verified end-to-end: include on a $275 reorder moved weekly landed 800→1075 and the closer's scoreboard cash in the same write). Overridden rows show a "reconciled by hand" badge.
- **Scoreboard page = two-view toggle** (Aug 13): Setter Scoreboard | Closer Scoreboard segmented control at the top of /scoreboard (deep-linkable with `?view=closers`). Setter view = summary cards + leaderboards (the show-rate-rep card was REMOVED Aug 13 — it displayed Belayneh's bonus comp to the whole team; do not re-add, his pay lives on /payroll); Closer view = closer summary cards (derived client-side from the same closerBoard rows as the table, so they can't disagree) + the closer table with drill-downs. The demos tile is labeled "Demos Booked" (Colin, Aug 13: "Demos Run" was misleading — the closers didn't run no-shows; it counts demos booked onto their calendars). Both views share the daily/weekly/monthly/all-time dimension toggle.
- **Closer board drill-down** (Aug 13): every closer row on /scoreboard expands to show the raw demos + closed-won deals behind its numbers, with the formula math spelled out (show-rate denominator, pending excluded, rescheduled rows listed-but-not-counted, closes-by-close-date vs demos-by-demo-date mismatch flagged per deal). Served by `/api/scoreboard?closerId=X` — same route, same dateFilter as the board, so detail can NEVER drift from the aggregate.
- **Closer board Cash Collected column** (Aug 13, Colin's explicit exception to the no-cash-on-scoreboard rule): per-closer upfront cash that LANDED in the period on closed-won deals, minus refunds landed in the period — cash-collected basis via payroll's `isCommissionable`/`loadDealMeta` (exported from payroll.ts) so the column always reconciles with commission. Drill-down lists every payment: counted (green), excluded grayed with verbatim reason from `commissionExclusionReason()` (reorder / later-charge>24h / misc / deal-not-closed-won), refunds as red negatives; total row = board cell by construction. Unattributed cash (closed-won deals with no closer) surfaces as a warning under the table. Admin gets an inline per-row reassign dropdown → existing audited /api/deals PATCH (moves the whole deal: its cash AND its close). This column is the ONLY cash on team-visible views — demos-page/day-lock/deals scoping for closers is unchanged.
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

## Confirmations (SendBlue show-rate system — Aug 2026)
Show-rate rep work surface at `/confirmations` (role: `show_rate_rep` + admin). Two touchpoints sent into setter-created iMessage groups via SendBlue (AI Agent line +13137683591 — reply-only, can't cold-initiate; the setter adding the line to the group at booking is what registers it):
- **T-1** (cron `/api/confirmations/t1`, 3pm ET): address-led confirmation for tomorrow's BRAND-NEW demos only. Rescheduled/already-asked prospects are skipped via the `ConfirmationSend` log (primary, dedup by email/phone on REAL sends) + `rescheduledFromId` (secondary). Copy branches: single address (frozen count 250-300 seeded off booking id) / multiple ("average around each one") / zips or area fallback (no number). Address variable: `Booking.listingAddress` (Calendly "Listing address / zip codes" Q&A) → Agent-table city by email → generic.
- **Day-of** (cron `/api/confirmations/dayof`, 8am ET): testimonial (`TESTIMONIAL_VIDEO_URL` media) + invite reminder to ALL pending demos today; "again" variant iff a prior day-of really sent. Auto-sends unless `CONFIRMATIONS_DAYOF_AUTO=false`.
- **Safety**: NO real text fires unless `SENDBLUE_LIVE=true` (everything logs as dry-run otherwise). T-1 auto-send off unless `CONFIRMATIONS_AUTO_SEND=true`, and even then only the staged-safe subset (single address, calendly source, unambiguous); graduation is earned via readiness metrics on the page (edit rate <3%, 0 catches, 14d).
- **Key files**: `src/lib/sendblue.ts`, `src/lib/confirmations/{copy,worklist,send,nudge}.ts`, `src/app/api/confirmations/*`, `src/app/confirmations/page.tsx`.
- **Group discovery is POLL-BASED** (`syncGroupsFromApi` — `GET /api/v2/messages` before every worklist build) — no SendBlue dashboard webhook config required. `src/app/api/webhooks/sendblue/route.ts` exists as an optional real-time enhancement if the webhook URL is ever pasted in their dashboard. Day-of sends as TWO messages: video first, text second (text owns the inbox preview).
- **Group matching gotchas (fixed Aug 11 2026 — don't regress):** every SendBlue message carries a full `participants[]` roster; `syncGroupsFromApi` MUST record all of it, not just `from_number` (the sender is usually the setter/line, so matching a booking by *prospect* phone fails if you store only the sender). And `normalizePhone` MUST coerce with `String(p ?? "")` — SendBlue returns some phone fields as numbers, and a raw `.replace` throws a `TypeError` that the sync's try/catch swallows, silently persisting zero groups (symptom: every row shows `no_group` / "call-only"). Existing rows self-heal on the next sync via the participants union. Remaining real cause of `no_group` after these fixes = the setter never made the group (add the line +13137683591 to an iMessage group with the prospect at booking).
- **Schema**: `SendblueGroup`, `ConfirmationSend` (append-only send log — dedup + instrumentation), `Booking.listingAddress` + `Booking.prospectTimezone` (captured in the Calendly webhook). Worklist state is computed live, never cached.
- Suppression is re-checked at send time (the send route rebuilds the worklist server-side; the client can't send to a row that stopped being sendable).

## Env Vars on Vercel
- DATABASE_URL (Neon)
- CALENDLY_API_TOKEN
- SENDBLUE_BASE_URL + SENDBLUE_API_KEY_ID + SENDBLUE_API_SECRET + SENDBLUE_LINE_NUMBER
- SENDBLUE_LIVE (unset/false = dry run; "true" = real texts)
- CONFIRMATIONS_AUTO_SEND ("true" = T-1 cron auto-sends staged-safe subset)
- CONFIRMATIONS_DAYOF_AUTO ("false" = day-of cron stops auto-sending)
- CONFIRMATIONS_REP_PHONE (show-rate rep's phone, E.164 — cron nudges go here as an iMessage FROM the SendBlue line, not Slack; the rep must text the line ONCE first so it's inbound-registered. Slack #show-rate-tpds is the fallback if the text fails) — NOT YET SET
- TESTIMONIAL_VIDEO_URL (day-of attachment) — NOT YET SET
- GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_KEY
- STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY
- FIREFLIES_API_KEY (comma-separated; Colin's is a team-admin key that sees ALL members' transcripts — covers Will/Matthew with no change)
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
1. **Andrea Reeves-Witherspoon invisible** — marked no_show, GCal invite dragged to next Thursday, sync returns 0 updated. She's not visible in UI on any date. Needs DB investigation via `/api/debug?name=andrea`. Likely causes: (a) calendarEventId format mismatch preventing lookup, (b) booking in DismissedEvent table, (c) weekId pointing to nonexistent/wrong week. Four code fixes already applied in gcal/route.ts but her specific record needs manual investigation.
2. **Calendly webhook event type filter** — if event type names change in Calendly, the filter in `/api/webhooks/calendly/route.ts` needs updating. Canary: if `calendly_non_demo_skipped` audit entries pile up, the filter is wrong. Current keywords: `farm | just | demo | e-mailers | setup`.

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
