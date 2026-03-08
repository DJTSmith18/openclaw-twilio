# Twilio Conversations — Setup Guide

Twilio has two separate services and it is genuinely confusing because they are
related but different things. Here is what each one is before you touch anything.

---

## What you are dealing with

### Conversations Service (`IS...`)
**Think of it as the inbox.** It stores conversation threads, participants, and
message history. Every conversation (`CH...` SID) lives inside a Conversations
Service.

**Where to find it:**
Twilio Console → **Conversations** (left sidebar) → **Manage** → **Services**

### Messaging Service (`MG...`)
**Think of it as the carrier.** It knows which phone numbers (DIDs) you own and
handles the actual SMS sending and receiving at the carrier level.

**Where to find it:**
Twilio Console → **Messaging** (left sidebar) → **Services**

> Note: the Conversations menu also has a "Messaging Service" shortcut — this
> is just a link to the same Messaging Service. The authoritative place is
> **Messaging → Services**.

---

## Step 1 — Get your Conversations Service SID (`IS...`)

1. In the left sidebar click **Conversations**
2. Click **Manage** → **Services**
3. You should see at least one service listed — click it
4. Copy the **SID** at the top (`IS...`)

Add it to your `openclaw.json`:
```json
"shared": {
  "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## Step 2 — Get your Messaging Service SID (`MG...`)

1. In the left sidebar click **Messaging**
2. Click **Services**
3. Click your service (or create one if none exists)
4. Copy the **SID** at the top (`MG...`)

Add it to your `openclaw.json` under the phone number:
```json
"accounts": {
  "+12125551234": {
    "name":                "My Line",
    "fromNumber":          "+12125551234",
    "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "dmPolicy":            "pairing"
  }
}
```

### What to do with all the other Messaging Service settings

**Integration tab — select "Send a Webhook"** and enter your webhook URL:
`https://your-domain.example.com/sms2`

Do NOT worry about "Autocreate a Conversation" — greyed out or not, it does
not matter for this plugin. Here is why:

Twilio has two separate mechanisms for routing inbound SMS into Conversations:
1. **Messaging Service → "Autocreate a Conversation"** — a Messaging Service
   level toggle
2. **Address Configuration** — a per-phone-number binding registered directly
   in the Conversations API

The plugin uses **Address Configuration** (option 2). On every startup it calls
the Twilio API to register your phone number with `autoCreation.enabled: true`
and your webhook URL. This is a lower-level, more direct binding that takes
priority over the Messaging Service toggle. The Messaging Service autocreate
setting is irrelevant once Address Configuration exists.

Select "Send a Webhook" + your URL to satisfy Twilio's requirement to have
something selected. It will never actually fire because Address Configuration
intercepts inbound traffic first.

Everything else on the Messaging Service page:

| Setting | What to do |
|---|---|
| **Properties → SID** | Copy this — it's the `MG...` you need |
| **Sender Pool** | Skip — you will assign the number from the phone number page (Step 3) |
| **Features (Sticky Sender, Smart Encoding, etc.)** | Leave defaults — none of these affect the plugin |

---

## Step 3 — Assign your phone number to the Messaging Service

This tells Twilio which DID the Messaging Service uses.
**Do this from the phone number page** — the Sender Pool tab in the Messaging
Service often does not show numbers that are already in use.

1. In the left sidebar click **Phone Numbers**
2. Click **Manage** → **Active Numbers**
3. Click your phone number
4. Scroll to **Messaging Configuration**
5. Under **Messaging Service** — select your Messaging Service from the dropdown
6. Clear the **"A message comes in"** webhook URL — leave it blank
7. Click **Save configuration**

> Clearing the webhook URL is required. Once the plugin registers Address
> Configuration on startup, Twilio routes all inbound SMS through Conversations
> and the old plain webhook is ignored.

---

## Step 4 — Make sure `baseUrl` is set

The plugin needs its public URL so it can register your phone number with Twilio
Conversations on startup. Confirm `baseUrl` is set in `openclaw.json`:

```json
"shared": {
  "accountSid":             "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "authToken":              "your-auth-token",
  "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "webhook": {
    "port":    3100,
    "path":    "/sms2",
    "baseUrl": "https://your-public-domain.example.com"
  }
}
```

---

## Step 5 — Restart OpenClaw

Restart OpenClaw. On startup the plugin registers your phone number with Twilio
Conversations (called Address Configuration). This tells Twilio:
> "When someone texts `+12125551234`, auto-create a Conversation and POST the
> message event to `https://your-domain.example.com/sms2`"

You do not create this manually — the plugin does it automatically.

Watch the logs for:
```
[twilio:gateway] Webhook server listening on 0.0.0.0:3100
[twilio:gateway] Address configuration created for +12125551234 → https://your-domain.example.com/sms2
```

`Address configuration already exists` is also fine — already registered.

---

## Step 6 — Verify

To confirm Address Configuration was registered:

1. In the left sidebar click **Conversations**
2. Click **Manage** → **Address Configurations**
3. Your phone number should be listed with Auto-creation enabled and your
   webhook URL

---

## Step 7 — Test

Send an SMS to your Twilio number from any phone. Look for in the logs:
```
[twilio:inbound] onMessageAdded conversationSid=CHxxxxxxxxxx author=+1xxxxxxxxxx
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No `Address configuration created` log on startup | Check `baseUrl` is set; check Twilio credentials |
| Address Configuration registered but no inbound | Check reverse proxy forwards POST to `localhost:3100/sms2` |
| 403 Forbidden on webhook | `baseUrl` doesn't match what Twilio sends to — no trailing slash, correct scheme |
| Still hitting old webhook | Old "A message comes in" URL not cleared (Step 3) |
| "Autocreate a Conversation" greyed out in Messaging Service | Normal — ignore it. The plugin uses Address Configuration instead, which does not require this toggle |
