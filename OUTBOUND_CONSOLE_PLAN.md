# GrassfedOS Outbound Console — Implementation Plan

## Context

Grassfed runs cold email (Smartlead) and cold SMS (rented GHL sub-accounts) campaigns targeting real estate agents. Today the workflow is manual: query a Claude project full of spreadsheets for filtered agent lists, then manually push those into Smartlead or GHL. There's no tracking of who was contacted, where, or when — leading to redundant outreach and slow execution.

The goal: build an **Outbound Console** inside the existing GrassfedOS dashboard so the lead setter can filter 220K+ real estate agents by location/production, push them to Smartlead or GHL campaigns in bulk, and see exactly who's been contacted across all channels. This is NOT a CRM or reply manager — Smartlead and GHL handle that. This is a targeting and distribution layer.

## Data Source

- 50 Google Drive folders (one per state), each containing a homes.com CSV
- Fields: first name, last name, email, phone, city, state, total transactions (5yr), total sales volume (5yr)
- ~220K records total, could grow to 2M with future data purchases
- Data provider delivers refreshed lists periodically — need an import strategy that can update existing records without creating duplicates

## Architecture: One Project, Three Phases

### Phase 1: Agent Database
Get the agent data into the app with filtering. Useful immediately even before campaigns are connected.

### Phase 2: Outbound Console
Add campaign push + tracking. Connect Smartlead API and GHL API. Email validation gate via Omni Verifier. Smartlead field formatting. Slack notifications on pushes.

### Phase 3: Scheduled Pushes
Automate recurring pushes so the setter doesn't have to manually think "who do we text next?" — campaigns stay fed on a schedule.

---

## Phase 1: Agent Database

### New Database Model

**File: `prisma/schema.prisma`** — add:

```prisma
model Agent {
  id                 String    @id @default(cuid())
  firstName          String
  lastName           String
  email              String?
  phone              String?
  state              String?
  city               String?
  zip                String?
  brokerage          String?
  totalTransactions  Int?      // 5-year total from homes.com
  totalVolumeCents   BigInt?   // 5-year total sales volume in cents
  avgTransactions    Int?      // calculated: totalTransactions / 5
  avgVolumeCents     BigInt?   // calculated: totalVolumeCents / 5
  source             String    @default("csv_import")
  importBatch        String?   // tracks which import brought this record in
  emailVerifyStatus  String?   // valid | invalid | risky | unknown
  emailVerifiedAt    DateTime? // when Omni Verifier last checked
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  outboundPushes     OutboundPush[]

  @@unique([email])           // prevent duplicate agents by email
  @@index([state, city])      // fast location filtering
  @@index([avgTransactions])  // fast production filtering
  @@index([lastName, firstName]) // fast name search
}
```

### New API Routes

| Route | Method | What it does |
|-------|--------|--------------|
| `/api/agents` | GET | List agents with pagination + filters (state, city, production range, search, contacted status). Returns 50 per page. |
| `/api/agents` | POST | Create a single agent manually |
| `/api/agents` | PATCH | Update an agent |
| `/api/agents/import` | POST | Bulk CSV import. Accepts JSON array of parsed agent rows. Uses `createMany({ skipDuplicates: true })` for speed. |
| `/api/agents/import` | GET | List past imports (audit trail) |

**New files:**
- `src/app/api/agents/route.ts`
- `src/app/api/agents/import/route.ts`

### Import Strategy (for 220K records)

1. CSV files are parsed client-side using `papaparse` (lightweight CSV parser, handles quoted fields)
2. Client sends agents to the API in batches of 1,000 rows
3. API uses `prisma.agent.createMany({ skipDuplicates: true })` — upserts by email
4. For **data refreshes** (new homes.com pull): same process. Existing agents matched by email get updated, new ones get created, nothing gets deleted
5. Import gets a batch ID so you can track "I imported TX on April 5th"

### New Page: `/agents`

**File: `src/app/agents/page.tsx`**

Layout:
1. **Header**: "Agent Database" + total count + "Import CSV" button
2. **Filter bar**: State dropdown, City text input, Production range (min/max), Search box (name/email), "Contacted" toggle (all / never contacted / contacted)
3. **Table**: Checkbox | Name | Email | Phone | City, State | Avg Transactions | Avg Volume | Contacted (channel badges) — paginated, 50 per page
4. **Bulk action bar** (appears when agents are selected): "[X] selected" + "Push to Email Campaign" + "Push to SMS Campaign"

**New component files:**
- `src/components/agents/filter-bar.tsx`
- `src/components/agents/agent-table.tsx`
- `src/components/agents/csv-import-dialog.tsx`
- `src/components/agents/bulk-action-bar.tsx`

### Sidebar Update

**File: `src/components/sidebar.tsx`** — add two nav items:
- "Agents" → `/agents`
- "Outbound" → `/outbound`

---

## Phase 2: Outbound Console

### New Database Models

```prisma
model OutboundCampaign {
  id                  String    @id @default(cuid())
  name                String
  channel             String    // smartlead | ghl
  externalId          String?   // Smartlead campaign ID or GHL workflow ID
  ghlSubAccountId     String?   // which GHL sub-account this uses
  status              String    @default("active") // active | paused | completed
  totalPushed         Int       @default(0)
  // Cached analytics (refreshed by cron or on-demand)
  totalSent           Int       @default(0)
  totalOpened         Int       @default(0)
  totalReplied        Int       @default(0)
  openRate            Float?
  replyRate           Float?
  lastSyncedAt        DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  pushes              OutboundPush[]
}

model OutboundPush {
  id           String   @id @default(cuid())
  agentId      String
  campaignId   String
  channel      String   // smartlead | ghl (denormalized for fast queries)
  pushedAt     DateTime @default(now())
  pushedBy     String?  // who triggered the push

  agent        Agent            @relation(fields: [agentId], references: [id])
  campaign     OutboundCampaign @relation(fields: [campaignId], references: [id])

  @@unique([agentId, campaignId])  // THE key constraint: no double-tapping
  @@index([campaignId])
  @@index([agentId])
}
```

### New API Routes

| Route | Method | What it does |
|-------|--------|--------------|
| `/api/outbound/campaigns` | GET | List campaigns from local DB |
| `/api/outbound/campaigns` | POST | Create a campaign (link to Smartlead or GHL) |
| `/api/outbound/campaigns/sync` | POST | Pull latest campaigns from Smartlead API, upsert locally |
| `/api/outbound/push` | POST | Push selected agents to a campaign. Checks dedup, calls Smartlead or GHL API, creates OutboundPush records |
| `/api/outbound/push` | GET | Push history — who was pushed where and when |
| `/api/outbound/analytics` | GET | Campaign performance (pulls from Smartlead API if stale, otherwise returns cached) |

**New files:**
- `src/app/api/outbound/campaigns/route.ts`
- `src/app/api/outbound/campaigns/sync/route.ts`
- `src/app/api/outbound/push/route.ts`
- `src/app/api/outbound/analytics/route.ts`

### Smartlead Integration

Uses the existing MCP tools at build time, but for the deployed app we need to call the Smartlead REST API directly:
- **List campaigns**: `GET https://server.smartlead.ai/api/v1/campaigns?api_key=KEY`
- **Push leads**: `POST https://server.smartlead.ai/api/v1/campaigns/{id}/leads` with lead objects
- **Get analytics**: `GET https://server.smartlead.ai/api/v1/campaigns/{id}/analytics?api_key=KEY`

**New env var needed**: `SMARTLEAD_API_KEY`

### GHL Integration

GHL uses REST API with location-level (sub-account) API keys:
- **Create contact**: `POST https://services.leadconnectorhq.com/contacts/` with Authorization header
- **Add to workflow**: `POST https://services.leadconnectorhq.com/contacts/{id}/workflow/{workflowId}`

**New env vars needed**: `GHL_API_KEY_1`, `GHL_API_KEY_2` (one per rented sub-account), `GHL_WORKFLOW_ID`

### Email Validation Gate (Omni Verifier)

Before leads get pushed to Smartlead (cold email), they MUST pass email validation. This prevents bounces and protects sender reputation.

**Flow:**
1. Setter selects agents and clicks "Push to Email Campaign"
2. System calls Omni Verifier API to validate all selected emails
3. Results: valid, invalid, risky, unknown
4. Only valid emails proceed to Smartlead push
5. Agent record gets an `emailVerifiedAt` timestamp + `emailVerifyStatus` field
6. Invalid/risky emails are flagged in the UI so the setter can see why they were excluded
7. Once validated, the result is cached — no re-verification on subsequent pushes unless data was refreshed

**New env var**: `OMNI_VERIFIER_API_KEY`

**New API route**: `/api/agents/verify` — POST with `{ agentIds: string[] }`, calls Omni Verifier, updates Agent records

### Smartlead Field Formatting

When pushing leads to Smartlead, fields must be mapped exactly to match email template variables:

| Agent DB Field | Smartlead Field | Notes |
|---|---|---|
| `email` | `Email` | Case-sensitive, required |
| `firstName` | `first_name` | Used in email copy |
| `city` | `City` | Case-sensitive — must be "City" not "city" |
| `lastName` | `last_name` | Lead details |
| `phone` | `phone` | Lead details |
| `state` | `state` | Lead details |
| `brokerage` | `company_name` | Lead details |
| `avgTransactions` | `avg_transactions` | Custom variable |
| `avgVolumeCents` | `avg_volume` | Custom variable (formatted as dollars) |

The push endpoint handles this mapping automatically — the setter never has to think about column names.

### Slack Outbound Notifications

New Slack channel: **#outbound-tpds** — gets notified when batches are pushed to campaigns.

Example messages:
- `📧 500 Texas agents ($80M+ volume) just entered "Q2 Cold Email - TX" campaign`
- `📱 200 California agents (15+ transactions) just entered SMS sequence via GHL`
- `⏰ Scheduled push fired: 300 FL agents pushed to "Spring Outreach" campaign`

**New env var**: `SLACK_OUTBOUND_WEBHOOK_URL`

### Push Flow (the core feature)

When the lead setter clicks "Push to Email Campaign" with 500 agents selected:

1. Frontend sends `{ agentIds: [...500 ids], campaignId: "xxx" }` to `/api/outbound/push`
2. API loads the campaign to get channel + externalId
3. API queries `OutboundPush` to filter out agents already pushed to this campaign
4. **If Smartlead (email):** calls Omni Verifier on unverified emails first → only valid emails proceed
5. Formats agent data into Smartlead field mapping (Email, first_name, City, etc.)
6. Calls Smartlead API to add leads (in batches of 100)
7. **If GHL (SMS):** pushes directly (no email verification needed for SMS)
8. Creates `OutboundPush` records for each successfully pushed agent
9. Sends Slack notification to #outbound-tpds
10. Returns `{ pushed: 487, alreadyContacted: 13, invalidEmail: 8, errors: 0 }`
11. Frontend shows success toast with the numbers

### New Page: `/outbound`

**File: `src/app/outbound/page.tsx`**

Layout:
1. **Header**: "Outbound Console" + "Sync Campaigns" button
2. **Campaign cards**: Each card shows campaign name, channel badge (Email/SMS), leads pushed count, open rate, reply rate
3. **Push History tab**: Table of recent pushes — date, agent name, campaign, channel

**New component files:**
- `src/components/outbound/campaign-card.tsx`
- `src/components/outbound/campaign-picker.tsx` (reused from agents page bulk action)
- `src/components/outbound/push-history.tsx`

### Cron Jobs

Add to `vercel.json`:
```json
{
  "path": "/api/outbound/campaigns/sync",
  "schedule": "0 */6 * * *"
},
{
  "path": "/api/outbound/scheduled",
  "schedule": "0 * * * *"
}
```
- Campaign analytics sync: every 6 hours
- Scheduled push processor: every hour (checks for due pushes)

---

## Phase 3: Scheduled Pushes

The setter shouldn't have to wake up and think "who do we text today?" They should set up a schedule once and let the system feed campaigns automatically.

### New Database Model

```prisma
model ScheduledPush {
  id              String    @id @default(cuid())
  campaignId      String
  name            String    // "Weekly TX Top Producers - Email"
  // Filter criteria (saved query)
  filterState     String?
  filterCity      String?
  filterMinProd   Int?
  filterMaxProd   Int?
  batchSize       Int       @default(200)  // how many agents per push
  // Schedule
  frequency       String    // daily | weekly | one_time
  dayOfWeek       Int?      // 0-6 for weekly (0 = Sunday)
  timeOfDay       String?   // "09:00" in ET
  nextRunAt       DateTime?
  lastRunAt       DateTime?
  isActive        Boolean   @default(true)
  createdBy       String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  campaign        OutboundCampaign @relation(fields: [campaignId], references: [id])
}
```

Also add to `OutboundCampaign`:
```prisma
  scheduledPushes ScheduledPush[]
```

### How Scheduled Pushes Work

1. Setter creates a scheduled push: "Every Monday at 9am, push 200 Texas agents with 10+ transactions to the 'Q2 TX Email' Smartlead campaign"
2. The system saves the filter criteria + schedule
3. Every hour, the cron job checks for due scheduled pushes (`nextRunAt <= now AND isActive`)
4. When a push is due:
   - Query agents matching the saved filters
   - Exclude agents already pushed to this campaign (via OutboundPush dedup)
   - For email campaigns: validate emails first via Omni Verifier
   - Push the batch to Smartlead or GHL
   - Create OutboundPush records
   - Send Slack notification: "⏰ Scheduled push fired: 200 TX agents pushed to Q2 TX Email"
   - Update `lastRunAt` and calculate `nextRunAt`
5. If the pool of matching agents runs dry (everyone's been contacted), the system sends a Slack alert: "⚠️ Scheduled push 'Weekly TX Top Producers' has no more uncontacted agents matching the filter. Consider expanding criteria or pausing."

### New API Routes

| Route | Method | What it does |
|-------|--------|--------------|
| `/api/outbound/scheduled` | GET | List scheduled pushes (also serves as cron handler) |
| `/api/outbound/scheduled` | POST | Create a new scheduled push |
| `/api/outbound/scheduled` | PATCH | Update/pause/resume a scheduled push |
| `/api/outbound/scheduled` | DELETE | Delete a scheduled push |

### UI Addition

On the `/outbound` page, add a "Schedules" tab showing:
- Active schedules as cards (campaign name, filter summary, frequency, next run, last run, agents remaining in pool)
- "Create Schedule" button → dialog with filter criteria + frequency picker
- Pause/resume toggle per schedule

---

## Build Order

### Step 1: Schema + Agent Import (get data in)
1. Add Agent model to Prisma schema, run migration
2. Build `/api/agents/import` endpoint
3. Build CSV import dialog in the UI
4. Import all 50 state files
5. Verify: 220K agents queryable, no duplicates

### Step 2: Agent Page (make it usable)
1. Build `/api/agents` with pagination + filters
2. Build the `/agents` page with filter bar + table
3. Add to sidebar
4. Verify: lead setter can filter by state, production, search by name

### Step 3: Email Validation
1. Build `/api/agents/verify` endpoint (Omni Verifier integration)
2. Add verification status badge to agent table
3. Verify: select agents → verify → see valid/invalid/risky badges

### Step 4: Outbound Schema + Smartlead Push
1. Add OutboundCampaign + OutboundPush models, run migration
2. Build `/api/outbound/campaigns/sync` to pull Smartlead campaigns
3. Build `/api/outbound/push` for Smartlead with field formatting + verification gate
4. Add campaign picker + push button to agents page
5. Add Slack notification on push
6. Verify: select agents → push to Smartlead → see them in Smartlead with correct field names

### Step 5: GHL Push
1. Build GHL push endpoint
2. Add GHL option to campaign picker (no email verification needed for SMS)
3. Verify: select agents → push to GHL → contacts appear in GHL sub-account

### Step 6: Outbound Page + Analytics
1. Build `/outbound` page with campaign cards
2. Build analytics sync (Smartlead stats → local cache)
3. Build push history view
4. Verify: lead setter can see campaign performance + who was pushed where

### Step 7: Scheduled Pushes
1. Add ScheduledPush model, run migration
2. Build scheduled push CRUD endpoints
3. Build cron job to process due pushes
4. Build "Create Schedule" UI on outbound page
5. Add "pool exhausted" Slack alert
6. Verify: create schedule → wait for cron → agents appear in campaign automatically

### Step 8: Data Refresh
1. Build "re-import" flow that updates existing agents by email match
2. Test with a refreshed homes.com file
3. Verify: updated production numbers, no duplicates, new agents added

---

## Verification Plan

After each step:
1. **Schema**: Run `npx prisma migrate dev` — verify no errors
2. **Import**: Import one state CSV, check record count in DB
3. **Filters**: Test each filter independently and combined
4. **Push**: Push 5 test agents to a test Smartlead campaign, verify they appear
5. **Dedup**: Try pushing the same agents again — should return "already contacted"
6. **GHL**: Push 5 test agents to GHL, verify contacts created
7. **Analytics**: Hit campaign analytics endpoint, verify data matches Smartlead dashboard
8. **Full flow**: Filter TX agents with 10+ avg transactions, select 50, push to Smartlead, verify in Smartlead dashboard, verify OutboundPush records created

---

## Files Changed/Created Summary

**Modified:**
- `prisma/schema.prisma` — 4 new models (Agent, OutboundCampaign, OutboundPush, ScheduledPush)
- `src/components/sidebar.tsx` — 2 new nav items
- `vercel.json` — 2 new cron jobs
- `CLAUDE.md` — document new routes and env vars
- `src/lib/slack.ts` — add `sendSlackOutbound` helper

**Created:**
- `src/app/agents/page.tsx`
- `src/app/outbound/page.tsx`
- `src/app/api/agents/route.ts`
- `src/app/api/agents/import/route.ts`
- `src/app/api/agents/verify/route.ts`
- `src/app/api/outbound/campaigns/route.ts`
- `src/app/api/outbound/campaigns/sync/route.ts`
- `src/app/api/outbound/push/route.ts`
- `src/app/api/outbound/analytics/route.ts`
- `src/app/api/outbound/scheduled/route.ts`
- `src/components/agents/filter-bar.tsx`
- `src/components/agents/agent-table.tsx`
- `src/components/agents/csv-import-dialog.tsx`
- `src/components/agents/bulk-action-bar.tsx`
- `src/components/outbound/campaign-card.tsx`
- `src/components/outbound/campaign-picker.tsx`
- `src/components/outbound/push-history.tsx`
- `src/components/outbound/schedule-dialog.tsx`

**New env vars:**
- `SMARTLEAD_API_KEY`
- `OMNI_VERIFIER_API_KEY`
- `SLACK_OUTBOUND_WEBHOOK_URL`
- `GHL_API_KEY_1` + `GHL_API_KEY_2`
- `GHL_WORKFLOW_ID`

---

## Prerequisites Before Testing

Things you'll need to gather before we start building:

1. **Smartlead API key** — from Smartlead dashboard (Settings > API)
2. **GHL sub-account API keys** — from GHL (Settings > Business Profile > API Keys) for each rented sub-account. Ask your setter if you're unsure where to find these
3. **GHL workflow ID** — the ID of the text 1 + text 2 sequence workflow. Your setter can find this in the GHL workflow builder URL
4. **Omni Verifier API key** — from your Omni Verifier account
5. **One homes.com CSV** — to test import with (any state). We'll use this to validate the column mapping before importing all 50
6. **A test Smartlead campaign** — create a dummy campaign in Smartlead so we can push test leads without affecting real campaigns
7. **Create a Slack channel** — #outbound-tpds (or whatever you want to call it), then create an incoming webhook URL for it
