# Bot sends through Sales

Bots and scripts (Chief SDR / Head of SDRs, the Solo Live nightly job, @coach, and anything else that texts) do not call Sendblue. They call this app. The Sales app holds the only Sendblue key.

A call is dry-run unless **both** `SENDBLUE_LIVE=true` and `BOT_SEND_LIVE=true`. `BOT_SEND_LIVE` defaults off, so bots stay dry-run after confirmation texts go live. Either flag left unset blocks the provider.

## Get a token

Colin mints a token per bot and stores only the hash.

```bash
TOKEN=$(openssl rand -hex 32)
HASH=$(printf %s "$TOKEN" | shasum -a 256 | awk '{print $1}')
echo "$HASH"
```

Give the raw `TOKEN` to that bot. Put the hash in `BOT_SEND_TOKENS` on the Sales app:

```json
{
  "0123abcd…64 hex chars…": "chief-sdr",
  "fedcba98…": "solo-live"
}
```

Caller names are lowercase letters, digits, `_`, and `-`, starting with a letter or digit (`chief-sdr`, `solo-live`, `coach`). The bot does not send its name. The token selects it.

Do not put the Sendblue API secret in a bot. Do not commit a token.

## Send

`POST /api/sendblue/bot-send`

`GET` on this path returns 405 and does not send.

Exactly one of `to` (a phone) or `groupId`. `content` can be empty when `mediaUrl` is an `https` URL. Sendblue accepts media on both 1:1 and group sends; this route passes it through on the same call as the text.

```bash
curl -sS -X POST "$BASE/api/sendblue/bot-send" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "solo-live-2026-10-29-group-abc",
    "groupId": "GROUP_ID",
    "content": "Tonight at 8.",
    "mediaUrl": "https://example.com/clip.mp4"
  }'
```

1:1 uses `"to": "+13135550100"` and omits `groupId`. A 10-digit US number is sent as `+1`.

The response is small:

```json
{ "status": "sent" }
{ "status": "dry_run" }
{ "status": "skipped", "reason": "idempotency" }
{ "status": "failed", "reason": "provider" }
```

`401` means the token is missing, wrong, or `BOT_SEND_TOKENS` is unset. `400` means the body is invalid (`reason` is `idempotency_key`, `recipient`, `content`, or `media_url`).

## Idempotency

`idempotencyKey` is required. 8–128 characters: letters, digits, `.`, `_`, `:`, `-`. Use a stable key per logical send, for example `solo-live-2026-10-29-<groupId>`.

The first call that wins the claim is the only one that can text. A retry with the same key, including a parallel duplicate, returns `skipped` / `idempotency` and does not call Sendblue again.

Dry-run and live are separate lanes. A dry-run does not consume the live key, so the same key can deliver **once** after both live flags are turned on. After a real send, that key will not send again.

A provider failure keeps the claim. The same key will not retry the provider. Pick a new key only after you know the first attempt did not land, and expect body dedupe to block an identical retry inside 24 hours.

## Skipped reasons

| reason | Meaning |
|---|---|
| `idempotency` | This caller already claimed this key in this dry/live lane. |
| `body_dedupe` | This phone or group already has this exact text (and media URL) in the last 24 hours, or another open claim for it today. Confirmation sends count. |
| `recipient_daily_cap` | This phone or group is at the daily cap (default 2, Eastern day), including confirmation sends that day. |
| `rate_cap` | The app-wide hourly cap is full (default 30, shared with confirmation texts). |
| `caller_rate_cap` | This bot is at its own hourly cap (default 10). |
| `opted_out` | The phone or group is on the STOP / opted-out list. |
| `caller_disabled` | This caller is listed in `BOT_SEND_DISABLED_CALLERS`. |

`caller_disabled` and `opted_out` do not burn the idempotency key. Caps and dedupe do not either: a later hour or a different body can still claim. The key is burned only when a claim is inserted (`sent`, `dry_run`, or `failed`).

## Kill switches

| Env | Effect |
|---|---|
| `SENDBLUE_LIVE` | Master switch for every Sendblue provider call in this app. Must be exactly `true`. |
| `BOT_SEND_LIVE` | Bot switch. Must be exactly `true`. Default off. |
| `BOT_SEND_DISABLED_CALLERS` | Comma-separated caller names that skip without sending. Example: `coach,solo-live`. |
| `BOT_SEND_TOKENS` | JSON map of token hash → caller name. Empty or invalid rejects every bot. |
| `BOT_SEND_MAX_PER_CALLER_PER_HOUR` | Default `10`. |
| `BOT_SEND_MAX_PER_RECIPIENT_PER_DAY` | Default `2`, per phone or group, America/New_York day. |
| `CONFIRMATIONS_MAX_SENDS_PER_HOUR` | Shared global cap. Default `30`. |
| `CONFIRMATIONS_DEDUPE_WINDOW_HOURS` | Identical body window. Default `24`. |

## Status and history

Last 24 hours, counts only (no message bodies):

```bash
curl -sS "$BASE/api/sendblue/bot-sends" -H "Authorization: Bearer $TOKEN"
```

```json
{ "hours": 24, "callers": [{ "caller": "chief-sdr", "sent": 1, "dry_run": 3, "skipped": 0, "failed": 0, "queued": 0 }] }
```

Recent Sendblue messages (read-only, does not send). `limit` defaults to 20 and caps at 100. Participants are not included.

```bash
curl -sS "$BASE/api/sendblue/messages?limit=20" -H "Authorization: Bearer $TOKEN"
```

Every attempt is stored with the caller, recipient or group id, body hash, and outcome. The message text is not stored on the bot row.
