# Twilio Conversations — Setup Guide

There are only two things to do in the Twilio Console. The plugin handles everything
else automatically on startup.

---

## Step 1 — Create a Messaging Service (if you don't have one)

1. Log in to [console.twilio.com](https://console.twilio.com)
2. In the left sidebar click **Conversations**
3. Click **Messaging Service**
4. If a service already exists, click it and copy its **SID** (`MG...`) — skip to Step 2
5. If none exists, click **Create Messaging Service**, give it a name (e.g. `OpenClaw`), click **Create**
6. Copy the **SID** at the top of the page (`MG...`)

Add it to your `openclaw.json` under the phone number account:

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

---

## Step 2 — Assign your phone number to the Messaging Service

This links your DID to the Messaging Service so Twilio knows which number to
use for Conversations. **Do this from the phone number's page, not from the
Messaging Service page** — the Sender Pool UI often doesn't show existing numbers.

1. In the left sidebar click **Phone Numbers**
2. Click **Manage** → **Active Numbers**
3. Click your phone number (e.g. `+12125551234`)
4. Scroll to **Messaging Configuration**
5. Under **Messaging Service**, click the dropdown and select the service you created
   (e.g. `OpenClaw`)
6. Clear the **"A message comes in"** webhook URL field — leave it completely blank
7. Click **Save configuration**

> Clearing the webhook URL is important. Once the plugin registers your number
> with Conversations (Step 4), Twilio routes all inbound SMS through Conversations
> and the old webhook URL is no longer used.

---

## Step 3 — Make sure `baseUrl` is set in your config

The plugin needs to know its public URL so it can tell Twilio where to send webhooks.
Make sure your `openclaw.json` has `baseUrl` set:

```json
"shared": {
  "accountSid":  "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "authToken":   "your-auth-token",
  "webhook": {
    "port":    3100,
    "path":    "/sms2",
    "baseUrl": "https://your-public-domain.example.com"
  }
}
```

---

## Step 4 — Restart OpenClaw

Restart OpenClaw. On startup the plugin automatically tells Twilio:
> "When someone texts `+12125551234`, create a Conversation and send the message
> event to `https://your-domain.example.com/sms2`"

This is called Address Configuration. You do not need to create it manually —
the plugin creates it via the Twilio API on every startup (idempotent, safe to
run repeatedly).

Watch the logs for:

```
[twilio:gateway] Webhook server listening on 0.0.0.0:3100
[twilio:gateway] Address configuration created for +12125551234 → https://your-domain.example.com/sms2
```

If it says `Address configuration already exists` that is also fine.

---

## Step 5 — Send a test SMS

Send an SMS from any phone to your Twilio number. You should see in the logs:

```
[twilio:inbound] onMessageAdded conversationSid=CHxxxxxxxxxx author=+1xxxxxxxxxx
```

That confirms it is working.

---

## Troubleshooting

**No inbound messages after restart**
Check that `baseUrl` is set in config with no trailing slash. Confirm your reverse
proxy forwards `POST /sms2` to `http://localhost:3100/sms2`.

**"Could not configure address" in logs**
Plugin failed to call the Twilio API on startup. Check credentials and outbound
internet access.

**403 Forbidden on the webhook**
`baseUrl` in config does not exactly match the URL Twilio is sending to. Check
scheme (`https://`), domain, and no trailing slash.

**Still getting messages on the old webhook**
The old phone number webhook URL was not cleared (Step 2). Go clear it.
