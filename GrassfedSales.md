# Grassfed Sales Dashboard — Complete Project Documentation

> **Last updated:** May 28, 2026
> **Deployed at:** barn.grsfd.ai (production branch: `main`)
> **Database:** Neon PostgreSQL via Prisma ORM

---

## What This Is

A real-time sales operations dashboard for Grassfed (cold email agency). Tracks the full sales pipeline: setter books demo → prospect shows up → closer runs demo → payment collected. Integrated with Calendly, Google Calendar, Stripe, Fireflies.ai, and Slack.

The sales team consists of:
- **Setters** (Ming, Luke, Jett) — book demos via cold calling
- **Closers** (Colin, Matthew, Will Farrell) — run demos and close deals. Will (`closer-will`) is the only comped closer (1099 contract, Aug 2026); Colin and Matthew are tracked for attribution but draw no pay. Mark departed Aug 2026 (`closer-mark`, isActive=false).
- **Show Rate Rep** (Belayneh) — ensures prospects show up to their demos

### Closer contract tracking (Aug 2026 — Will's 1099 contract)
- **Lead source (fed vs self-sourced), §4.6**: `Booking.leadSource` + `Deal.leadSource` (`fed` | `self_sourced`, default fed). Fixed at booking: when the Calendly/GCal "Booked by" field names the closer hosting the demo, the booking is `self_sourced`; everything else (setter name, blank, mismatched host) is `fed` — matching the contract's §4.12(b) presumption. Reschedule successors INHERIT the original row's leadSource; who handles a reschedule never changes it. Corrections: FED/SELF toggle on /demos (audit action `lead_source_update`) and /deals; a demo-side change syncs the linked deal. Convention: **when a closer books their own deal they type their own name in "Booked by"**.
- **Closer payroll** (`src/lib/payroll.ts` → `CLOSER_COMP`, keyed by TeamMember id): weekly commission on new-business cash collected that week (16% fed / 25% self; payments with effective customerStatus "returning" or revenueType "misc" excluded), clawback line for refunds/lost disputes within 60 days of collection (`Payment.refundedAt`, set by the Stripe webhook), and monthly base $3,500 emitted in the payroll week containing the month's last day — volume floor (<20 closes → $0) and quality floor (fed close rate <25% → −$200/full point, floor $1,500, applied only at 15+ fed demos showed).
- **Closer self-serve**: `/api/closer/stats` + "My Numbers" panel on /deals (closer role) — MTD closes, fed close rate, cash split, commission, projected base.
- **Closer view scoping**: closers double as setters — they see all demos, Bookings Today, and the scoreboard, but NO revenue figures (financial feed/day cash hidden on /demos; /api/deals scoped to their own deals, no unlinked-payments feed; dashboard + KPIs admin-only). Pages are read-mostly for them (status + FED/SELF edits; no add/delete/bulk/locks/reassign). Demo DELETE and day locks are admin-only server-side. All demo/deal edits audit-log the session user's name.
- **Cross-booking setter credit**: "Booked by: <closer>" on a different closer's calendar credits the booker as setter (fed); on their own calendar → self_sourced, no setter. Closer names never auto-create setter rows.
- **Pre-demo nurture sequence** (12 emails) is NOT this repo: grassfedlite on Railway (`app/api/routes/calendly.py`, org-scoped webhook at admin.grsfd.ai) schedules `demo_emails` sent via Resend. Event-type filtered like our webhook (farm|just|demo|e-mailers|setup, added 2026-08-12 after onboarding clients received nurture emails). New closer event types are covered automatically.

---

## Architecture Overview

```
Calendly ──webhook──→ /api/webhooks/calendly ──→ DB (Booking + Demo)
                                                  ├──→ Slack #setter-tpds
                                                  └──→ Slack #sales-team

Google Cal ──10min cron──→ /api/sync/gcal ──→ DB (reschedule detection)

Fireflies ──webhook──→ /api/webhooks/fireflies ──→ DB (mark showed)
           ──30min cron──→ /api/sync/fireflies      ├──→ Slack #show-rate-tpds
                                                     └──→ Slack #sales-team

Stripe ──webhook──→ /api/webhooks/stripe ──→ DB (Payment)
                                              ├──→ Slack #closer-tpds
                                              └──→ Slack #sales-team

Dashboard ──60s auto-refresh──→ /api/demos, /api/kpis ──→ UI
```

---

## Database Schema

### TeamMember
```
id, name, role (setter|closer|show_rate_rep), tier (1-4),
slackUserId?, cumulativeShows, consecutive15PlusWeeks,
excludeFromLeaderboard (default false), isActive
```

### Week
```
id, weekStart (Monday UTC), weekEnd, status (draft|confirmed),
confirmedBy?, confirmedAt?, notes?
```

### Booking
```
id, weekId, prospectName, prospectEmail?, prospectPhone?,
setterId?, bookedAt?, demoDate, calendarEventId? (unique),
source (calendly_webhook|gcal_sync|manual). gcal_sync and manual both count toward scoreboard activity (see /api/scoreboard).
```

### Demo
```
id, bookingId (unique), weekId, closerId?,
status (pending|showed|no_show|cancelled|rescheduled),
confirmedBy?, confirmedAt?, firefliesTranscriptId?,
hasFirefliesRecording, notes?
```

### Deal
```
id, demoId? (unique), weekId, closerId?, prospectName,
prospectEmail?, stripeCustomerId?, stripeSubscriptionId?,
dealType (subscription|one_time), month1Cash (cents),
status (closed_won|closed_lost|pending|held), closedAt?
```

### Payment
```
id, dealId?, weekId?, stripePaymentIntentId? (unique),
stripeCustomerId?, amountCents, currency, status (succeeded|pending|failed),
paidAt, isMonth1, isSubscription,
revenueType (mrr|one_time|misc|unknown), revenueTypeOverride?,
customerStatus (new|returning|unknown), customerStatusOverride?,
customerName?, customerEmail?,
matchStatus (matched|unmatched|needs_review), matchReason?
```

### SetterDailyScore
```
id, setterId, date, bookings, pigeonTier, points,
tierCrossings (CSV: "4,9,12")
@@unique([setterId, date])
```

### DayLock
```
id, weekId, date, dayOfWeek, demoCount, showCount,
noShowCount, cashCents, lockedBy, lockedAt
@@unique([weekId, date])
```

### DismissedEvent
```
id, calendarEventId (unique), reason, dismissedAt
```

### Also: PayrollRun, PayrollLineItem, Expense, ExpenseCategory, SyncLog, AuditLog

---

## Environment Variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `CALENDLY_API_TOKEN` | Calendly personal access token (colin@grsfd.co) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `calendar-tracking@grassfed-calendar-tracking.iam.gserviceaccount.com` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | RSA private key for GCal service account |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (whsec_...) |
| `STRIPE_SECRET_KEY` | Stripe secret key for API calls |
| `FIREFLIES_API_KEY` | Comma-separated. Colin's key is a Fireflies TEAM ADMIN key — verified Aug 2026 that it returns transcripts org-wide (Matthew, Danielle, Will incl.), so new closers need NO key change, just a seat in the Fireflies workspace. Mark's key still in the list is harmless dead weight. |
| `SLACK_WEBHOOK_URL` | #sales-team channel webhook |
| `SLACK_CEO_WEBHOOK_URL` | CEO DM webhook |
| `SLACK_SETTER_WEBHOOK_URL` | #setter-tpds channel webhook |
| `SLACK_SHOWRATE_WEBHOOK_URL` | #show-rate-tpds channel webhook |
| `SLACK_CLOSER_WEBHOOK_URL` | #closer-tpds channel webhook |
| `SLACK_DATAVERIFICATION_WEBHOOK_URL` | #setter-daily-verify channel webhook |

---

## API Routes (30 endpoints)

### Webhooks (instant, event-driven)
| Route | Purpose |
|-------|---------|
| `POST /api/webhooks/calendly` | Calendly invitee.created/canceled → creates booking + demo, fires setter Slack |
| `POST /api/webhooks/stripe` | payment_intent.succeeded → creates payment, classifies MRR/one-time + new/returning, auto-matches to demo |
| `POST /api/webhooks/fireflies` | Transcription completed → matches to demo, marks showed |

### Sync Crons (scheduled polling)
| Route | Schedule | Purpose |
|-------|----------|---------|
| `/api/sync/gcal` | Every 10 min | GCal service account reads Colin + Mark calendars, detects reschedules |
| `/api/sync/fireflies` | Every 30 min | Fetches transcripts, auto-marks shows, flags missing transcripts |
| `/api/sync` | Every 15 min | Legacy Stripe + Calendar sync |
| `/api/sync/leaderboard` | Every 2hr weekdays | Setter leaderboard update |

### Slack Notifications
| Route | Schedule | Channel |
|-------|----------|---------|
| `/api/slack/setter/morning` | 9AM ET weekdays | #setter-tpds — Gay Pigeon + tag all setters |
| `/api/slack/setter/midday` | 12PM ET weekdays | #setter-tpds — per-setter status + pigeon tier |
| `/api/slack/setter/eod` | 6PM ET weekdays | #setter-tpds — final scores + points + pipeline |
| `/api/slack/setter/confirm` | 10:05PM ET weekdays | #setter-daily-verify — per-setter WTD stats + verify link + CEO summary |
| `/api/verify` | GET + POST | Setter verification — load demos/state, submit confirmations + flags → CEO DM |
| `/api/verify/admin` | GET + POST | CEO verification — overview, resolve flags, add missing demos, lock week |
| `/api/slack/daily` | 6PM ET daily | #sales-team — daily recap |
| `/api/slack/ceo` | Sat 11AM ET | CEO DM — weekly P&L briefing |
| `/api/slack` | Wed + Sat | #sales-team — midweek/weekly summary |

### Admin / Diagnostic
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/admin/lookup` | GET | Look up booking by name/email, optionally fix status/date |
| `/api/admin/setter-audit` | GET, POST | Find/correct bookings whose `setterId` disagrees with the latest Calendly "Booked by" (rebooking attribution backfill) |
| `/api/debug` | GET, POST | Booking/demo investigation + bulk fixes (fix_stale_noshows, fix_rescheduled_status, fix_dismissed_reschedule) |

### CRUD
| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/demos` | GET, POST, PATCH, DELETE | Demo management, bulk confirm, status updates |
| `/api/demos/lock` | GET, POST, DELETE | Day locking system |
| `/api/deals` | GET, POST, PATCH | Deal management + unlinked payments |
| `/api/payments` | PATCH | Override revenue type, customer status, match to demo |
| `/api/team` | GET, POST, PATCH | Team member CRUD (name, role, tier, slackUserId) |
| `/api/weeks` | GET, POST | Week management, auto-creates current + future weeks |
| `/api/kpis` | GET | Weekly KPI calculations |
| `/api/scoreboard` | GET | Setter scoreboard with weekly + all-time stats; closer board. `?closerId=X` → drill-down: the raw demos + closed-won deals behind that closer's board numbers (same dateFilter as the board so detail cannot drift), tallies recomputed from the listed rows, no cash |
| `/api/economics` | GET | Admin sales economics. `?granularity=weekly\|monthly\|all_time` → period series (cohort per-X metrics + landed cash); `?detail=true&start&end` → receipts: per-setter cohort economics, every demo row, every landed payment with counted/excluded verdict |
| `/api/expenses` | GET, POST, DELETE | Expense tracking |
| `/api/payroll` | GET, POST | Payroll generation |
| `/api/settings` | GET, POST | Sync logs, expense categories |
| `/api/setup` | GET, POST | Full re-import (wipes + re-seeds) |
| `/api/reconcile` | POST | Auto-match payments, auto-detect shows |

---

## Frontend Pages

| Page | Path | Key Features |
|------|------|-------------|
| Dashboard | `/` | KPI cards (New Revenue headline), setter/closer performance tables, auto-refresh 60s |
| Demos | `/demos` | Week calendar grid, day/week toggle, side-by-side financial feed, bulk select, day locking, clickable payment badges |
| Deals | `/deals` | Deal management, unlinked payments, revenue type tracking |
| Scoreboard | `/scoreboard` | Medal-ranked setter leaderboard, all-time stats, show rate rep bonus tracker |
| Payroll | `/payroll` | Weekly payroll generation with tier-based compensation |
| P&L | `/pnl` | Revenue breakdown, expense tracking, margin calculation |
| Team | `/team` | Add/edit team members with Slack user ID field |
| Settings | `/settings` | Sync logs, expense categories |

---

## Slack Channel System

### #setter-tpds — Setter Pigeon Gamification
**Tier System (daily bookings):**
| Tier | Bookings | Pigeon | Points |
|------|----------|--------|--------|
| Bad | 0-3 | Sad Pigeon | 0 |
| Decent | 4-8 | Lesbian Pigeon | 1 |
| Great | 9-11 | TPD | 2 |
| Legendary | 12+ | Tuffest Pigeon | 5 |

**Messages:**
- 9AM: Good morning, all setters tagged, Gay Pigeon GIF
- Real-time: Every booking → "{emoji} @setter is at {count} today" + "TOTAL: X"
- Real-time: Tier crossing at 4/9/12 → achievement GIF + message
- 12PM: Per-setter midday status with pigeon tier
- 6PM: Per-setter final score + points + team pipeline count
- Corrections: When bookings deleted → "⚠️ Booking removed, updated count"

### #show-rate-tpds — Show Rate Tracking
- Fires when any demo is marked "showed" (Fireflies auto, admin manual, payment match)
- Tags the setter who booked it
- Shows: prospect name, closer, weekly show total, pending pipeline
- Corrections: When showed→pending or demo deleted

### #closer-tpds — Closer Performance
- Fires on every Stripe payment
- Tags the matched closer
- Shows: amount, MRR/one-time, new/returning, weekly close total, new revenue total

### #sales-team — General Alerts
- Real-time: New demo booked, payment received
- Daily recap at 6PM ET
- Weekly summary Wed + Sat

### CEO DM
- Saturday 11AM ET: P&L, revenue breakdown, anomaly flags

---

## Key Library Functions

### src/lib/setter-game.ts
- `getTierForCount(count)` → pigeon tier
- `formatMention(member)` → `<@SLACK_ID>` or bold name
- `getETDateBounds()` → today's start/end in UTC (Eastern Time)
- `isWeekday()` → boolean
- `getSetterTodayBookings(setterId)` → count, tier, daily score
- `checkAndFireTierCrossing(setterId, count)` → fires Slack if threshold crossed
- `getAllSetterScoresToday()` → all setter daily stats
- `getPipelineCount()` → future demos count
- `sendShowNotification(...)` → posts to #show-rate-tpds
- `sendCloseNotification(...)` → posts to #closer-tpds

### src/lib/matching.ts
- `matchPaymentToDemo(payment)` → match by email then fuzzy name
- `matchTranscriptToDemo(title, date, bookings)` → match Fireflies to demo
- `autoDetectShows(weekId, transcripts)` → bulk mark demos as showed

### src/lib/kpis.ts
- `calculateWeeklyKPIs(weekId)` → full weekly metrics including New Revenue

### src/lib/slack.ts
- `sendSlackTeam/CEO/Setter/ShowRate/Closer(text, blocks?)` → 5 channels

### src/lib/utils.ts
- `getWeekRange(date)` → Monday-Sunday UTC boundaries
- `formatCents(cents)` → "$1,500.00"
- `formatPercent(value)` → "75.0%"

---

## Payment Classification System

Two separate dimensions:

**Revenue Type** (what kind of payment):
- `mrr` — subscription (detected by "Subscription" in Stripe description or invoice present)
- `one_time` — single purchase
- `misc` — delay fees, refunds, etc.
- `unknown` — needs manual classification

**Customer Status** (new vs existing):
- `new` — customer has zero prior succeeded payments in Stripe history
- `returning` — customer has at least one prior payment
- `unknown` — no customer ID on payment

Both have `Override` fields for manual correction via clickable badges in the UI.

**Weekly Sales KPI = New Revenue** = sum of payments where customerStatus = "new"

---

## Data Flow: New Demo Booking

1. Prospect books via Calendly
2. **Calendly webhook** fires instantly → creates Booking + Demo with setter attribution
3. **Slack #setter-tpds** → "{emoji} @setter is at {count} today" + team total
4. **Slack #sales-team** → "New demo booked: {prospect} with {closer}"
5. **GCal sync** (10 min) → detects if already exists, skips or catches reschedules
6. **Fireflies** records the demo call
7. **Fireflies webhook/sync** → matches transcript to demo → marks as "showed"
8. **Slack #show-rate-tpds** → "+1 SHOW for @setter"
9. **Stripe webhook** → payment arrives → classified + matched → deal created
10. **Slack #closer-tpds** → "+1 CLOSE for @closer"
11. **Dashboard** auto-refreshes every 60s, no flash/scroll reset

---

## Setter Attribution — How It Actually Works

**There is one Calendly link, owned by the CEO, used for all demo bookings.** Setters do not have individual Calendly links and there are no per-setter UTM tags. Attribution works entirely through a free-text **"Booked by"** field that the setter types into the Calendly intake form at booking time.

- The webhook reads `Booked by:` from the Calendly event description (and falls back to a `Booked by` Q&A answer or `utm_source`/`utm_campaign` if present, but the description is the primary signal).
- The gcal_sync (10-min cron) reads the same field from the GCal event description.
- Whatever name the setter typed → looked up against `TeamMember` where `role='setter'` via case-insensitive `contains` match.
- No match found → setter is created as a new `TeamMember` with `excludeFromLeaderboard: true` (so a typo or operator-bystander name doesn't pollute the leaderboard).

**Consequences of this design:**
- If the setter forgets to type a name, the booking lands as **unattributed** (`setterId IS NULL`).
- If the setter typos their own name (or types a co-worker's name, or the prospect typed their own name into that field), the booking lands credited to the wrong person.
- Operators correct these via `manual_backfill` audit-logged updates from the admin UI.
- **Automation must not overwrite manual setter corrections.** The compositeId-match path in `sync/gcal/route.ts` does not re-parse the setter — see comment in that file. Only genuinely new booking events (reschedule splits, past-no-show rebooks) resolve a fresh setter, and even those fall back to the previous setter rather than clearing.

---

## Immutable Week History (Aug 2026 redesign)

**A booking row never leaves its week.** Weekly numbers are write-once: what you see during a week is what that week says forever. This replaced the old model where reschedules moved the row (demoDate, weekId, bookedAt bump), silently rewriting past weeks' booking counts, no-shows, and even migrating already-showed demos across payroll weeks.

- **Real reschedule/rebook (new Calendly/GCal event, or a dragged event whose demo already has an outcome):** the old row is **frozen** — `supersededAt` set, still-pending demo closed out as `rescheduled` (excluded from show rate); terminal outcomes (`showed` / `no_show` / `cancelled`) are untouchable — and a **successor row** is created in the new week, linked via `rescheduledFromId`, credited to the most-recent setter. **Activity credit (`bookedAt`) is INHERITED from the original row** when the prior demo was still pending — a reschedule is the same booking moving, not a new booking, so "New Bookings" stays in the original booking week (the successor's `weekId`/demo still live in the new week, so shows/pending land there). Only when the prior demo already had a terminal outcome (showed/no_show/cancelled) is the successor a genuinely new meeting and gets `bookedAt = now`. One prospect can therefore have a chain of rows: the original "set" plus one "reset" per cross-event reschedule — but the whole chain shares one booking-activity credit, counted once (via the live row) in the week it was first booked. (Fixed 2026-08-17, commit `4ffea0b` — successors previously always got `bookedAt = now`, so each reschedule re-counted as a new booking in the rebook week.)
- **Same GCal event dragged while the demo is still pending:** move-in-place (demoDate/weekId follow the meeting; `bookedAt` untouched — a drag is not a new booking event). Nothing had happened yet, so no history is lost.
- **Duplicate deliveries / cross-channel echoes (time unchanged):** enrich missing contact fields only. Never bump `bookedAt`, never overwrite setter (fill only if null).
- **Superseded rows are frozen history**: every dedup/matcher filters `supersededAt: null`; the cancel handler ignores cancels for superseded events; syncs skip them. When a same-event drag splits a terminal row, the successor takes over the `calendarEventId` and the old row's id gets a `_superseded_<id>` suffix.
- **Deletes** remain hard deletes (junk removal) but the audit log now stores a full JSON snapshot of booking + demo for recovery.
- **"As-booked" reference number** on the dashboard + scoreboard: live bookings (`supersededAt: null`) *created* in the period (`createdAt`, never mutated). Shown when it differs from the credited activity count; it is the immutable "what we saw live" number for any week. Because it counts by `createdAt` (the reschedule day) while New Bookings counts by the inherited `bookedAt` (original booking day), the two can diverge for a rescheduled booking — expected.
- `Booking.bookedAt` is set once and never bumped. For a pending reschedule the successor **inherits the original's `bookedAt`** (activity credit stays in the original booking week); only a re-engagement after a terminal outcome gets a fresh `bookedAt`. The scoreboard New Bookings + as-booked counts filter `supersededAt: null` so a multi-reschedule chain counts once. **Backfill trap:** re-anchoring `bookedAt` on live successors must precede any filter that drops frozen rows, or cross-week reschedules fall out of their original week.

---

## Deduplication Strategy

Both Calendly webhook and GCal sync can create the same booking. Dedup checks (all restricted to live rows, `supersededAt: null`):
1. `calendarEventId` exact match (different formats: `calendly_UUID` vs `eventId_Colin`)
2. Email + 4-hour date window match
3. First name + 4-hour date window match

Dismissed events: When a demo is deleted, its `calendarEventId` is added to `DismissedEvent` table. Both GCal sync and Calendly webhook check this before creating.

---

## Team Member Slack IDs

| Member | Role | Slack ID |
|--------|------|----------|
| Ming | Setter | U0A1CD7BU9W |
| Luke | Setter | U0APNBM43S7 |
| Jett | Setter | U0B6EQNL6EA |
| Christian | Setter | U0BA1725JD9 |
| Nick | Setter | U0BA468RHB7 |
| Oliver | Setter | U0BB1S4SG48 |
| Colin | Closer | U09UH7YSPV1 |
| Mark | Closer | U0AKMP7A36H |

Logan (setter) was deactivated May 2026 — `isActive: false`, historical data preserved.

Christian, Nick, and Oliver were promoted from auto-created Calendly attribution rows on 2026-06-12. They are active tier-1 setters, included in the leaderboard, have dashboard PIN `0000`, and keep their existing booking attribution.

New team members: Add via Team page with Slack User ID field for real @mentions. Attribution is automatic once they're in the DB — GCal events with "Booked by: [name]" in the description will resolve to the matching setter.

---

## Remaining Pillars (not yet built)

1. **CEO Slack Deep Dive** — deeper P&L, anomaly detection, cash flow week-over-week
2. **UI Cleanup** — cleaner typography, mobile, cards (waiting on example UIs from Colin)
3. **Admin/Auth** — role-based access (admin sees all, closers see their stuff, setters see bookings). Filter returning revenue from sales team view
4. **Weekly Video Coaching** — aggregate Fireflies transcripts, AI coaching highlights with Tuff Pigeon Doctor moments
5. **Historical Data Import** — Colin will dump 2026 data at the end

---

## Build & Deploy

```bash
# Local development
npm run dev

# Build (auto-runs prisma generate + db push)
npm run build

# Deploy: push to branch, promote latest deployment to production in Vercel
git push -u origin claude/recap-session-progress-CNZlu
# Then: Vercel → Deployments → latest → Promote to Production
```

---

## Project Structure

```
/home/user/Sales
├── CLAUDE.md                    # Session handoff (auto-read by Claude)
├── GrassfedSales.md             # This file — full project documentation
├── prisma/schema.prisma         # 16 models
├── vercel.json                  # 11 cron jobs
├── package.json                 # Next.js 14 + integrations
├── src/
│   ├── app/
│   │   ├── page.tsx             # Dashboard
│   │   ├── layout.tsx           # Sidebar + header + week selector
│   │   ├── globals.css          # Tailwind + CSS variables
│   │   ├── demos/page.tsx       # Demos page (largest file ~850 lines)
│   │   ├── deals/page.tsx       # Deals page
│   │   ├── scoreboard/page.tsx  # Setter scoreboard
│   │   ├── payroll/page.tsx     # Payroll
│   │   ├── pnl/page.tsx         # P&L
│   │   ├── team/page.tsx        # Team management
│   │   ├── settings/page.tsx    # Settings
│   │   └── api/                 # 29 API routes
│   │       ├── webhooks/        # Calendly, Stripe, Fireflies
│   │       ├── sync/            # GCal, Fireflies, Calendly, Leaderboard
│   │       ├── slack/           # Team, CEO, Daily, Setter (morning/midday/eod)
│   │       ├── demos/           # CRUD + lock
│   │       ├── deals/           # CRUD
│   │       ├── payments/        # Override + match
│   │       ├── team/            # CRUD
│   │       ├── kpis/            # Weekly calculations
│   │       ├── scoreboard/      # Setter rankings
│   │       └── ...              # setup, seed, import, reconcile, etc.
│   ├── components/
│   │   ├── sidebar.tsx          # Navigation (8 items)
│   │   ├── week-selector.tsx    # Week dropdown with localStorage persistence
│   │   ├── sync-button.tsx      # Manual sync trigger
│   │   ├── dashboard/kpi-card.tsx
│   │   └── ui/                  # badge, button, card (Radix-based)
│   └── lib/
│       ├── db.ts                # Prisma client singleton
│       ├── slack.ts             # 6 channel functions
│       ├── setter-game.ts       # Pigeon gamification + Slack helpers
│       ├── matching.ts          # Payment + transcript matching
│       ├── kpis.ts              # Weekly KPI calculations
│       └── utils.ts             # Formatting + date utilities
└── public/
    └── pigeons/                 # (placeholder for pigeon GIF assets)
```
