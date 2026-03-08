# Twilio Conversations — Setup Guide

Follow these steps **in order**. The plugin handles webhook registration automatically,
but you need to create the services and point the config at them first.

---

## Step 1 — Create a Conversations Service

A Conversations Service is the container that holds your conversations and messages.
Some accounts have a default; if yours does not, create one now.

1. Log in to [console.twilio.com](https://console.twilio.com)
2. In the left sidebar click **Conversations**
3. Click **Manage** → **Services**
4. If you already see a service listed, skip to Step 2
5. If the list is empty, click **Create new Conversation Service**
6. Give it a name (e.g. `OpenClaw`)
7. Click **Create**
8. You will land on the service page — copy the **Service SID** at the top
   (it starts with `IS...`, e.g. `IS1234abcd1234abcd1234abcd1234abcd`)

**Add the SID to your `openclaw.json`:**
```json
"channels": {
  "twilio": {
    "shared": {
      "accountSid": "ACxxxxxxxx...",
      "authToken": "...",
      "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
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

---

## Step 2 — Create a Messaging Service and add your phone number

A Messaging Service links your Twilio phone number to the Conversations Service so
that Twilio knows which DID to use for outbound SMS replies.

1. In the left sidebar click **Messaging**
2. Click **Services**
3. Click **Create Messaging Service**
4. Give it a name (e.g. `OpenClaw SMS`)
5. Under **Select what you want to do with this Messaging Service** choose
   **Market my services to users** (or any option — it does not matter)
6. Click **Create Messaging Service**
7. You are now on the Sender Pool tab — click **Add Senders**
8. Choose **Phone Number** from the dropdown, click **Continue**
9. Tick the checkbox next to your phone number, click **Add Phone Numbers**
10. Click **Step 3: Set up integration** (or navigate to the **Integration** tab)
11. Leave all webhook fields **blank** for now — the plugin registers its own webhooks
12. Click **Complete Messaging Service Setup**
13. Copy the **Messaging Service SID** from the top of the page
    (starts with `MG...`, e.g. `MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

**Add it to your `openclaw.json`:**
```json
"channels": {
  "twilio": {
    "shared": { ... },
    "fromNumber": "+12125551234",
    "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## Step 3 — Clear the old phone number webhook

Your phone number previously had a plain SMS webhook URL set on it. Now that
Conversations owns the DID, that URL is no longer used and should be cleared to
prevent conflicts.

1. In the left sidebar click **Phone Numbers**
2. Click **Manage** → **Active Numbers**
3. Click your phone number (e.g. `+12125551234`)
4. Scroll down to **Messaging Configuration**
5. Under **"A message comes in"** you will see a webhook URL — **delete it** (clear
   the field completely)
6. Leave the dropdown set to **Webhook**
7. Click **Save configuration**

---

## Step 4 — Start OpenClaw

Restart OpenClaw. On startup the plugin will automatically:

1. Open the webhook server on your configured port
2. Register an **Address Configuration** in Twilio that tells Twilio:
   > "When someone texts `+12125551234`, auto-create a Conversation and POST
   > the `onMessageAdded` event to `https://your-domain.example.com/sms2`"

Watch the logs — you should see:

```
[twilio:gateway] Webhook server listening on 0.0.0.0:3100
[twilio:gateway] Address configuration created for +12125551234 → https://your-domain.example.com/sms2
```

If you see `Address configuration already exists` that is also fine — it means the
registration was already done on a previous run.

---

## Step 5 — Verify it worked in the Twilio Console

1. In the left sidebar click **Conversations**
2. Click **Manage** → **Address Configurations**
3. You should see a row for your phone number with:
   - **Type**: SMS
   - **Address**: your E.164 phone number
   - **Auto-creation enabled**: Yes
   - **Webhook URL**: `https://your-domain.example.com/sms2`

If the row is missing, see the Troubleshooting section below.

---

## Step 6 — Send a test SMS

Send an SMS from any mobile phone to your Twilio number. You should see in the
OpenClaw logs:

```
[twilio:inbound] onMessageAdded conversationSid=CHxxxxxxxxxx author=+1xxxxxxxxxx
[twilio:inbound] direct session twilio:default:direct:+1xxxxxxxxxx
```

That confirms inbound is working. Replies from OpenClaw will go out via the
Conversations API and appear on the same thread.

---

## Troubleshooting

**"Address configuration created" appears in logs but no inbound messages arrive**

Your reverse proxy may not be forwarding POST requests correctly. Verify that:
- `https://your-domain.example.com/sms2` routes to `http://localhost:3100/sms2`
- The proxy passes the raw body and the `X-Twilio-Signature` header unchanged

**"Could not configure address" in the logs**

The plugin could not call the Twilio API on startup. Check:
- `accountSid` and `authToken` are correct
- `baseUrl` is set in your config (without it the plugin skips registration)
- The server has outbound internet access

**"403 Forbidden" on the webhook endpoint**

Twilio signature validation failed. This usually means `baseUrl` in your config does
not exactly match the URL Twilio is sending to. Make sure:
- No trailing slash on `baseUrl`
- Scheme matches (`https://` not `http://`)
- If behind a proxy, the proxy is not rewriting the URL

**Address Configuration row is missing from the Twilio Console**

The registration did not run. Confirm `baseUrl` is set in your config, restart
OpenClaw, and check the logs for any error after the "Webhook server listening" line.

---

## Quick reference — what goes where in openclaw.json

```json
{
  "channels": {
    "twilio": {
      "enabled": true,
      "shared": {
        "accountSid":            "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "authToken":             "your-auth-token",
        "conversationServiceSid":"ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "webhook": {
          "port":    3100,
          "path":    "/sms2",
          "baseUrl": "https://your-public-domain.example.com"
        }
      },
      "fromNumber":          "+12125551234",
      "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "dmPolicy":            "pairing"
    }
  }
}
```

| Field | Where to find it | Required |
|---|---|---|
| `accountSid` | Twilio Console → top right account info | Yes |
| `authToken` | Twilio Console → top right account info | Yes |
| `conversationServiceSid` | Conversations → Manage → Services → your service → SID | Yes (if no default) |
| `webhook.baseUrl` | Your public domain (ngrok URL, reverse proxy, etc.) | Yes |
| `webhook.path` | Whatever path your reverse proxy forwards | Yes |
| `webhook.port` | Local port the plugin listens on | Yes |
| `fromNumber` | Your Twilio phone number in E.164 format | Yes |
| `messagingServiceSid` | Messaging → Services → your service → SID | Recommended |
