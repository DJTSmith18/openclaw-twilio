# Twilio Conversations API — Setup Guide

This guide covers everything you need to configure in the Twilio Console to use the
OpenClaw Twilio plugin on the `conversations` branch.

---

## Prerequisites

Before touching the Twilio Console, make sure your `openclaw.json` has `baseUrl` set
under the webhook config. The plugin uses this on startup to register the correct
webhook URL with Twilio automatically.

```json
"channels": {
  "twilio": {
    "shared": {
      "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "authToken": "your-auth-token",
      "webhook": {
        "port": 3100,
        "path": "/sms2",
        "baseUrl": "https://your-public-domain.example.com"
      }
    },
    "fromNumber": "+12125551234"
  }
}
```

> **`baseUrl` is required.** Without it, the plugin cannot register your DID with
> Twilio Conversations and inbound messages will not arrive.

---

## Step 1 — Verify Conversations is enabled on your account

1. Log in to [console.twilio.com](https://console.twilio.com)
2. In the left sidebar, click **Messaging** → **Conversations** → **Manage** →
   **Services**
3. You should see at least one service listed (Twilio creates a **Default
   Conversations Service** automatically for all accounts)
4. Note the **Service SID** (starts with `IS...`) — you only need this if you want to
   use a non-default service (see Step 5 below)

---

## Step 2 — Ensure your phone number supports SMS via Messaging Service

The Conversations API works best when your DID is attached to a **Messaging Service**
(not configured as a standalone number). This is optional but recommended for RCS,
10DLC compliance, and fallback handling.

1. Go to **Messaging** → **Services**
2. If you don't have one, click **Create Messaging Service**
   - Give it a friendly name (e.g. `OpenClaw`)
   - Under **Sender Pool**, add your DID(s)
3. Note the **Messaging Service SID** (starts with `MG...`)
4. Add it to your `openclaw.json` under the account config:
   ```json
   "fromNumber": "+12125551234",
   "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

> If you skip this step, the plugin will still work — outbound messages go directly
> from the DID rather than through a Messaging Service.

---

## Step 3 — Start OpenClaw and verify Address Configuration is registered

Address Configuration is what tells Twilio to route all inbound SMS/MMS for your DID
through the Conversations API instead of the old plain SMS webhook.

**The plugin registers this automatically on startup** — you do not need to create it
manually. Just:

1. Restart OpenClaw (`openclaw restart` or however you manage it)
2. Watch the logs for:
   ```
   [twilio:gateway] Webhook server listening on 0.0.0.0:3100
   [twilio:gateway] Address configuration created for +12125551234 → https://your-domain.example.com/sms2
   ```
   Or if already registered from a previous start:
   ```
   [twilio:gateway] Address configuration already exists for +12125551234
   ```

### Verify in the Twilio Console

1. Go to **Messaging** → **Conversations** → **Manage** → **Address Configurations**
2. You should see a row for each of your DIDs with:
   - **Type**: SMS
   - **Address**: your phone number in E.164
   - **Auto-creation**: Enabled
   - **Webhook URL**: `https://your-domain.example.com/sms2`
   - **Webhook filters**: `onMessageAdded`

If the row is missing, check that `baseUrl` is set in your config and that OpenClaw
has network access to reach Twilio's API on startup.

---

## Step 4 — Clean up the old phone number webhook (recommended)

Before Conversations, your DID probably had a plain SMS webhook URL set directly on
the phone number. This is now superseded by Address Configuration, but it is good
practice to clear it to avoid confusion.

1. Go to **Phone Numbers** → **Manage** → **Active Numbers**
2. Click your DID
3. Scroll to **Messaging Configuration**
4. Under **"A message comes in"**, clear the webhook URL (set it to blank or
   `http://`)
5. Click **Save**

> This is safe — once Address Configuration is registered, Twilio routes all inbound
> traffic through Conversations and ignores the legacy phone number webhook.

---

## Step 5 — (Optional) Use a dedicated Conversations Service SID

By default, all conversations go into Twilio's **Default Conversations Service**.
If you want to isolate OpenClaw conversations into their own service:

1. In **Messaging** → **Conversations** → **Manage** → **Services**, click
   **Create new service**
2. Give it a name (e.g. `OpenClaw`)
3. Copy the **Service SID** (`IS...`)
4. Add it to your `openclaw.json`:
   ```json
   "shared": {
     ...
     "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   }
   ```
5. Restart OpenClaw — Address Configuration will be registered against this service

---

## Step 6 — Send a test message

Send an SMS to your DID from any phone. You should see in the OpenClaw logs:

```
[twilio:inbound] onMessageAdded conversationSid=CHxxx author=+1xxxxxxxxxx
[twilio:inbound] direct session twilio:default:direct:+1xxxxxxxxxx
```

If the log shows `[twilio:gateway] Address configuration already exists` but you get
no inbound events, check that your reverse proxy is correctly forwarding POST requests
to `http://localhost:3100/sms2`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No `[twilio:inbound]` logs on incoming SMS | Address Configuration not registered | Check `baseUrl` in config; check Twilio Console → Address Configurations |
| `[twilio:gateway] Could not configure address` on startup | Twilio API error | Check accountSid/authToken credentials |
| Address Configuration registered but no webhook fires | Reverse proxy not forwarding to correct path | Verify proxy routes `POST /sms2` → `localhost:3100/sms2` |
| `403 Forbidden` on webhook | Signature validation failed | Ensure `baseUrl` in config exactly matches the public URL Twilio is sending to (no trailing slash, correct scheme) |
| Outbound send fails with "No conversation found" | First outbound to a new number | Plugin auto-creates a conversation — check credentials and `fromNumber` |

---

## What changed from the old Messages API setup

| | Before (Messages API) | After (Conversations API) |
|---|---|---|
| Inbound routing | Phone number webhook → `/sms2` | Address Configuration → auto-creates Conversation → `onMessageAdded` → `/sms2` |
| Outbound | Individual `messages.create()` per recipient | Single `conversations.messages.create()` → Twilio fans out |
| Group threading | Jaccard similarity + local UUID | Native `ConversationSid` (`CH...`) — Twilio-managed |
| Group detection | 30s polling loop | Instant via `participants.list()` on first encounter |
| Event Streams | Required for group recipient correlation | No longer needed |
| Session stability | Could drift if members changed | Stable — `CH...` never changes |
