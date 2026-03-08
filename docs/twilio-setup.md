# Twilio Conversations — Setup Guide

There are only two things to do in the Twilio Console. The plugin handles everything
else automatically on startup.

---

## Step 1 — Get your Messaging Service SID

1. Log in to [console.twilio.com](https://console.twilio.com)
2. In the left sidebar click **Conversations**
3. Click **Messaging Service** (or create one if you don't have one yet)
4. Copy the **SID** — it starts with `MG...`

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

## Step 2 — Clear the old phone number webhook

Your phone number previously had a plain SMS webhook URL on it. Clear it now to
prevent conflicts with Conversations.

1. In the left sidebar click **Phone Numbers**
2. Click **Manage** → **Active Numbers**
3. Click your phone number
4. Scroll to **Messaging Configuration**
5. Under **"A message comes in"** — delete the webhook URL (clear the field)
6. Click **Save configuration**

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

Restart OpenClaw. The plugin will automatically register your phone number with the
Twilio Conversations API (called "Address Configuration") on startup.

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
