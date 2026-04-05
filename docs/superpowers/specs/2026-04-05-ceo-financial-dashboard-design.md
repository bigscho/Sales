# CEO Financial Dashboard — Design Spec

**Date:** 2026-04-05
**Status:** Phase 1
**Test Case:** Close March 2026 cleanly using this system

## Problem

The CEO currently spends 3-4 hours at the end of every month manually reconstructing P&L from Mercury exports, Amex statements, Stripe data, and spreadsheets. There is no daily visibility into financial health, no running P&L, and no system that learns from past categorization decisions. Monthly close is a reconstruction project instead of a confirmation step.

## Solution

A CEO Financial Dashboard built into the existing Sales Tracker app that provides:
- Daily glance at financial health
- Weekly forced review with category-level drill-down
- Auto-generated monthly P&L that's 95% done before month-end
- Live MRR tracking with manual churn flagging
- A learning categorization system that gets smarter over time

## Approach: Mercury-First, Stripe-Enriched

Mercury is the single source of truth for all cash flow. Stripe provides enrichment for customer payment detail and MRR classification. Amex provides itemized credit card charges via CSV upload (API later if available).

### Reconciliation Rules

- Mercury → Amex payment detected → tagged as `internal_transfer`, excluded from P&L
- Mercury → Stripe deposit detected → tagged as `internal_transfer`, linked to individual Stripe payments for detail
- Mercury → known vendor → auto-categorized based on learned merchant mappings
- Mercury → unknown transaction → `needs_review`, surfaced in weekly review
- Amex charges → dated when incurred (not when statement is paid), categorized independently

### Why Mercury-First

- Matches the CEO's mental model (checks Mercury first)
- Single source of truth eliminates double-counting by design
- The Amex/Mercury overlap problem is solved structurally: Mercury-to-Amex = internal transfer, Amex charges = real expenses dated when incurred
- Amex statement cycle (15th-15th) doesn't distort monthly P&L because we use Amex charge dates, not Mercury payment dates

## Data Sources

| Source | Method | Frequency | What It Provides |
|---|---|---|---|
| Mercury | API | Daily auto-sync | All bank transactions (complete cash picture) |
| Stripe | API (already built) | Daily auto-sync | Customer payment detail, MRR vs one-time, subscription data |
| Amex | CSV upload (API later) | Weekly or monthly | Itemized credit card charges with incurred dates |

### Important Stripe Note

Stripe's data model has nuances (subscriptions with multiple items, prorations, trials, metered billing) that can produce wrong MRR numbers if assumptions are made. The Stripe API docs must be read carefully before implementation to ensure MRR calculations are accurate. MRR = active Stripe subscriptions only. If it's not a Stripe subscription, it's not MRR.

## Category System

### Top-Level Classifications

| Classification | Description |
|---|---|
| Business | Operating expenses — categorized into subcategories below |
| Payroll | Team compensation — tracked per person |
| Personal | CEO personal expenses flowing through the same accounts |
| Internal Transfer | Mercury → Amex payments, Stripe deposits, etc. Excluded from P&L |

### Business Expense Categories

| Category | Known Vendors |
|---|---|
| Email Infrastructure | PuzzleInboxes, Smartlead, Zapmail (AMEX), Zapmail (Mercury), Cheap Inboxes, SendSentry, GoDaddy |
| Software | Maruno Management, ClickUp, Fireflies, Google Workspace, Anthropic (Claude sub), DocuSign, Lovable, Supabase, NordVPN, Crisp |
| Automation | Zapier, Make, OpenAI, SerpApi, n8n, Anthropic API |
| Data | BatchData, PropertyShark |
| Internal Marketing | HighLevel (GHL), Perspectives, Calendly, Webflow, Wistia |
| CRM | Airtable |
| Communication | Slack, Loom |
| Accounting | QuickBooks |
| Education | Affirm (Hormozi) |
| Verification | OmniVerifier |
| Fees | Intl Transaction Fees |

Categories are user-editable. The CEO can add, rename, merge, or retire categories at any time.

### Revenue Classifications

| Type | How Identified |
|---|---|
| MRR | Stripe subscription payments only |
| One-Time / A La Carte | Stripe non-subscription payments |
| Other Revenue | Non-Stripe inflows on Mercury (ACH, wire, etc.) |

### Payroll (February Baseline)

IT Global (Will CTO), Axia Growth (Will), Matthew Schofield, Danielle, Belayneh Barkley, Augmantra (Sebastian), Chris Schofield, Bay State Book (Nijal), Leila, Logan, Marselis

Total: ~$15,394.84/month

### Personal Expense Examples

Colombia Food/Lodging/Misc, Personal Transfers, Airbnb, AMEX Membership Fee, Uber, Bold/Wompi (payments), Peptide Pack, Pharmacy/Health, Flights, Apple Subscriptions, Barber/Grooming, Gym, Spa/Wellness, Didi Food

### Co-mingled Funds

The CEO co-mingles personal and business funds in the same Mercury account. The system must:
- Default unknown transactions to `needs_review` (never auto-classify as business if uncertain)
- Learn personal merchant mappings over time (Uber, Gym, etc.)
- Keep personal expenses visible but separated from business P&L

## Learning Categorization System

### Merchant Mappings

When the CEO confirms or reclassifies a transaction, the system stores the merchant-to-category mapping. Next time that merchant appears, it auto-categorizes with high confidence.

- New/unknown merchants → `needs_review`
- Known merchants with high confidence → auto-categorized, included in weekly review for acceptance
- Over time, fewer transactions need manual review

### Adjustments & Reimbursements

Some transactions have offsets (e.g., Anthropic API: $1,755 gross - $1,780 reimbursement = -$25 net). The system supports linking transactions as adjustments so the P&L reflects net amounts.

## Weekly Review Workflow

Every week, the CEO dashboard surfaces a review:

### Step 1 — Category-Level Summary

Each category shows its weekly total, transaction count, and auto-categorization status. Categories with all high-confidence auto-categorized transactions show a checkmark. Categories with any `needs_review` items show an alert.

### Step 2 — Drill Into Categories

Expand any category to see itemized transactions. Accept or deny each categorization. For uncategorized items, assign a classification (business + subcategory, personal, or internal transfer). Mappings are saved for future auto-categorization.

### Step 3 — Confirm the Week

Once all transactions are reviewed, confirm the week. This locks it. Confirmed weeks feed into the monthly P&L as settled data.

### Stacking

Unconfirmed weeks stack. If the CEO skips a Monday, they see "2 weeks pending review" until cleared. No transactions get silently lost.

## P&L Views

### Daily Glance (`/ceo` dashboard home)

- Current Mercury balance
- MTD revenue (MRR | One-Time | Other)
- MTD expenses (Business | Payroll | Personal)
- MTD net profit/loss (revenue - business expenses - payroll)
- Transactions needing review count
- Sparkline trends — revenue and expenses over the last 30 days

### Weekly P&L

Generated from confirmed week data:
- Revenue breakdown: MRR, one-time, other
- Expense breakdown by category
- Payroll total (per-person detail expandable)
- Net profit/loss for the week
- Week-over-week comparison
- Sales metrics from existing tracker: cash per booking, cash per show, cash per close

### Monthly P&L

Auto-assembled from confirmed weeks:
- Full revenue breakdown (MRR vs one-time vs other)
- Full expense breakdown by category with itemized drill-down
- Payroll breakdown by person
- Personal expenses separated out
- Internal transfers excluded
- Adjustments & reimbursements reflected
- Month-over-month comparison
- Monthly close button — confirm the month in ~5 minutes

## Live MRR Tracker

### Metrics

- **Active MRR** — currently billing Stripe subscriptions
- **Projected Monthly MRR** — Active MRR minus known churns not yet reflected in Stripe
- **New MRR** — new subscriptions added this month
- **Churned MRR** — MRR lost to churn this month
- **Net MRR Change** — new minus churned

### Churn Workflow

When the CEO learns a client is leaving (before Stripe cancellation):
1. Find the client on the dashboard
2. Hit "Mark Churning"
3. Their MRR immediately drops out of projected MRR
4. Stripe subscription remains active until billing cycle ends
5. Weekly P&L shows: `MRR: $45,000 active → $43,000 projected (2 pending churns)`

This is a financial flag only in Phase 1. Operational churn workflows (deactivating campaigns, revoking inboxes, stopping BatchData) are Phase 3.

## Data Architecture

### New Prisma Models

**Transaction** — Unified ledger for all financial transactions
- `id`, `createdAt`, `updatedAt`
- `externalId` — ID from source system (Mercury tx ID, Stripe payment ID, etc.)
- `source` — enum: mercury, stripe, amex
- `date` — when the transaction occurred
- `amountCents` — positive for inflows, negative for outflows
- `merchantName` — raw name from source
- `description` — raw description from source
- `classification` — enum: business, personal, payroll, internal_transfer
- `categoryId` — FK to expense category
- `status` — enum: auto_categorized, needs_review, confirmed
- `confidenceScore` — float, how sure the system is
- `stripePaymentId` — optional FK to existing Payment model
- `weeklyCloseId` — optional FK, set when week is confirmed
- `adjustmentForId` — optional self-FK for reimbursements/offsets
- `notes` — optional CEO notes

**MerchantMapping** — Learned vendor-to-category associations
- `id`, `createdAt`, `updatedAt`
- `merchantPattern` — string pattern to match (e.g., "SMARTLEAD", "ZAPIER")
- `classification` — business, personal, payroll, internal_transfer
- `categoryId` — FK to expense category (for business classification)
- `confidence` — float, increases with each confirmation
- `timesConfirmed` — count of how many times this mapping was confirmed

**WeeklyClose** — Weekly review status
- `id`, `createdAt`, `updatedAt`
- `weekId` — FK to existing Week model
- `status` — enum: pending, confirmed
- `confirmedAt` — timestamp
- `transactionCount` — total transactions in the week
- `reviewedCount` — transactions that were manually reviewed

**MonthlyClose** — Monthly close status with snapshot
- `id`, `createdAt`, `updatedAt`
- `month` — integer (1-12)
- `year` — integer
- `status` — enum: open, confirmed
- `confirmedAt` — timestamp
- `totalRevenueCents` — snapshot
- `totalExpensesCents` — snapshot
- `totalPayrollCents` — snapshot
- `totalPersonalCents` — snapshot
- `netProfitCents` — snapshot

**MrrEvent** — Churn and subscription events
- `id`, `createdAt`, `updatedAt`
- `type` — enum: new_subscription, churn, reactivation
- `clientName` — who
- `mrrAmountCents` — the MRR amount affected
- `effectiveDate` — when it takes effect
- `stripeSubscriptionId` — optional link to Stripe
- `notes` — optional context

### Existing Models Leveraged (No Changes)

- `Payment` — Stripe payment detail, links to Transaction for enrichment
- `Week` — Weekly boundaries, reused for WeeklyClose alignment
- `TeamMember` — Payroll attribution
- `PayrollRun` / `PayrollLineItem` — Payroll costs
- `ExpenseCategory` — Migrated into MerchantMapping system

### API Routes

| Route | Purpose |
|---|---|
| `GET/POST /api/ceo/transactions` | List, filter, search transactions |
| `POST /api/ceo/mercury/sync` | Pull Mercury transactions via API |
| `POST /api/ceo/amex/import` | CSV upload for Amex charges |
| `PATCH /api/ceo/categorize` | Accept/deny/reclassify transactions |
| `GET/POST /api/ceo/weekly-review` | Get pending review items, confirm week |
| `GET /api/ceo/pnl` | P&L calculations (weekly, monthly, MTD) |
| `GET/POST /api/ceo/mrr` | Live MRR with churn events |
| `POST /api/ceo/monthly-close` | Confirm monthly close |

### Pages

| Page | Purpose |
|---|---|
| `/ceo` | Dashboard home — daily glance view |
| `/ceo/review` | Weekly review workflow |
| `/ceo/pnl` | Detailed P&L (weekly/monthly toggle) |
| `/ceo/transactions` | Full transaction ledger with search/filter |

## Phasing

### Phase 1 — CEO Financial Dashboard (current)

- Mercury API integration — daily transaction sync
- Amex CSV upload — import itemized charges
- Stripe enrichment — link deposits to individual payments, accurate MRR from subscriptions
- Unified transaction ledger
- Auto-categorization with learning merchant mappings
- Business vs personal vs internal transfer classification
- Weekly review workflow with category drill-down and confirm
- P&L views: daily glance, weekly, monthly
- Live MRR tracker with manual churn flagging
- Monthly close workflow
- **Test case: close March 2026 cleanly**

### Phase 2 — Client Economics

- Client-level P&L (revenue minus COGS/CAC per client)
- Labor cost attribution per client (average allocation model)
- Distinction between onboarding new agents vs maintaining existing clients
- Amex API integration (if available)

### Phase 3 — Client Offboarding Automation

- Churn as an operational workflow (not just a financial flag)
- Assign/delete inboxes on churn
- Deactivate email campaigns
- Stop BatchData pulls for churned clients
- Prevent technical debt from orphaned client resources
