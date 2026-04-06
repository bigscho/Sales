# Operational Metrics & Unit Economics — Plan

## Context
The sales dashboard tracks the full funnel (Booking → Demo → Deal → Payment) and has good weekly KPIs (show rate, close rate, cash/booking, cash/show, cash/close) plus a CEO financial dashboard (P&L, MRR, expenses). But there's no customer-level entity, no cost attribution (COGS vs CAC vs overhead), no LTV, no unit economics. This plan adds the metrics that matter for understanding organizational efficiency.

## What Already Works (No Changes Needed)
- cashCollected, avgCashPerClose, cashPerBooking, cashPerShow
- showRate, closeRate, per-setter/closer stats
- MRR tracking (active, churned, new via MrrEvent)
- P&L with category-level expense breakdown
- Payroll line items by type (base, per_show, commission, bonus)

---

## Key Question for You Before We Build

**The single most important decision: how should your 11 expense categories be classified?**

Each category needs a purpose tag — is it **COGS** (cost to deliver service to clients), **CAC** (cost to acquire new clients), or **overhead** (general business)?

Here's my suggested mapping — **you need to confirm/adjust this:**

| Category | Suggested | Reasoning |
|---|---|---|
| Email Infrastructure | **COGS** | Inboxes/warmup used for client campaigns |
| Automation | **COGS** | Zapier/Make flows power client deliverables |
| Data | **COGS** | BatchData lookups for client campaigns |
| CRM | **COGS** | Airtable managing client accounts |
| Internal Marketing | **CAC** | HighLevel, Calendly, Webflow = lead gen |
| Verification | **CAC** | OmniVerifier validates outbound leads |
| Communication | **Overhead** | Slack/Loom are internal |
| Software | **Overhead** | ClickUp, Fireflies, etc. |
| Accounting | **Overhead** | QuickBooks |
| Education | **Overhead** | Professional development |
| Fees | **Overhead** | Bank/processing fees |

**Also:** Is Email Infrastructure used for YOUR outbound prospecting or for running campaigns ON BEHALF of clients? That determines if it's COGS or CAC.

All setter/closer payroll = **CAC** (their job is acquisition).

---

## Phase 1: Sales Efficiency Metrics (no schema changes)

### New calculations from existing data:
1. **Revenue per setter** — follow Payment → Deal → Demo → Booking → setterId (data exists, join not performed today)
2. **Cost per show** — setter payroll / shows
3. **Cost per close** — total payroll / closes
4. **Setter ROI** — revenue from setter's bookings / setter's payroll cost
5. **Closer ROI** — revenue from closer's deals / closer's payroll cost
6. **Outbound ROI** — revenue from `Booking.blastSourced=true` bookings / (SMS credits + setter pay for those shows)
7. **Average deal cycle time** — Booking.bookedAt → Deal.closedAt
8. **Trailing 30/60/90 day** time dimensions (extend `time-range.ts`)

### New API: `GET /api/ceo/sales-efficiency`
Returns funnel metrics, revenue attribution, cost efficiency, per-setter/closer economics, outbound ROI.

### Files to modify:
- `src/lib/time-range.ts` — add trailing_30/60/90
- `src/lib/kpis.ts` — add setter revenue attribution
- New: `src/app/api/ceo/sales-efficiency/route.ts`
- New: sales efficiency section on `/ceo/metrics` page

---

## Phase 2: Cost Purpose Classification (small schema change)

### Schema change:
```prisma
// Add to FinancialCategory:
costPurpose  String  @default("overhead")  // cogs | cac | overhead
```

### What this unlocks:
- **CAC** = (all payroll + CAC-tagged expenses) / new customers acquired
- **Gross Margin** = (Revenue - COGS-tagged expenses) / Revenue
- **Contribution Margin** = (Revenue - COGS - CAC) / Revenue

### Files:
- `prisma/schema.prisma` — add costPurpose field
- `src/app/api/ceo/seed/route.ts` — seed defaults
- `src/app/api/ceo/pnl/route.ts` — split by costPurpose
- New: settings UI to let you tag categories
- New: `GET /api/ceo/unit-economics` route

---

## Phase 3: Customer Model (enables LTV, per-client P&L, cohorts)

### New model:
```prisma
model Customer {
  id                   String    @id @default(cuid())
  name                 String
  email                String?   @unique
  stripeCustomerId     String?   @unique
  firstDealDate        DateTime?
  acquisitionChannel   String?   // outbound_email | outbound_sms | inbound | referral
  setterId             String?
  closerId             String?
  cohortMonth          String?   // "2026-01" for cohort analysis
  status               String    @default("active") // active | churned | paused
  currentMrrCents      Int       @default(0)
  lifetimeRevenueCents Int       @default(0)
  notes                String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  deals                Deal[]
  payments             Payment[]
}
```

Add nullable `customerId` to Deal and Payment. Non-breaking migration + backfill script.

### What this unlocks:
- **LTV** — historical (sum of all payments) + predictive (ARPU / churn rate)
- **LTV:CAC ratio** — the single most important unit economics metric (target: 3:1+)
- **CAC payback period** — CAC / monthly revenue per customer
- **Per-client P&L** — revenue - allocated COGS - acquisition cost per customer
- **Cohort analysis** — group by cohortMonth, track retention curves
- **Logo churn rate** — customers churned / customers at start of period
- **Net Revenue Retention (NRR)** — (beginning MRR + expansion - churn) / beginning MRR

### Files:
- `prisma/schema.prisma` — Customer model, relations
- New: `POST /api/ceo/customers/backfill` — hydrate from existing data
- New: `GET /api/ceo/customers` — list with LTV, MRR, status
- New: `GET /api/ceo/customers/[id]` — per-client P&L detail
- New: `/ceo/customers` page

---

## Phase 4: MRR/Churn Enhancements

### Schema:
```prisma
// Add to MrrEvent:
reason  String?  // budget | no_results | competitor | paused | other
```
Support `expansion` / `contraction` event types.

### What this unlocks:
- Churn reason tracking for pattern detection
- NRR calculation with expansion/contraction
- Average customer lifespan (1 / monthly churn rate)

---

## Summary: What Metrics We'd Have After All 4 Phases

### Sales Efficiency
| Metric | Status |
|---|---|
| Cash per booking / show / close | Already exists |
| Show rate, close rate | Already exists |
| Revenue per setter | Phase 1 |
| Setter/Closer ROI | Phase 1 |
| Cost per show / close | Phase 1 |
| Outbound ROI | Phase 1 |
| Deal cycle time | Phase 1 |

### Unit Economics
| Metric | Status |
|---|---|
| CAC | Phase 2 |
| Gross margin | Phase 2 |
| Contribution margin | Phase 2 |
| LTV | Phase 3 |
| LTV:CAC ratio | Phase 3 |
| CAC payback period | Phase 3 |
| Per-client P&L | Phase 3 |
| Revenue per FTE | Phase 1 |

### Client Success
| Metric | Status |
|---|---|
| Logo churn rate | Phase 3 |
| Revenue churn rate | Phase 2 (MrrEvent data exists) |
| NRR | Phase 4 |
| Cohort retention | Phase 3 |
| Average customer lifespan | Phase 3 |
| Churn reasons | Phase 4 |

---

## Verification
- Phase 1: compare sales-efficiency API output against manually calculated values from the dashboard
- Phase 2: verify COGS + CAC + overhead = total expenses (should sum correctly)
- Phase 3: verify Customer backfill count matches unique stripeCustomerIds in Payment table
- All phases: existing P&L numbers should not change
