# Twilio Conversations — Setup Guide

You need to create two things in the Twilio Console, then add their IDs to your
config. The plugin handles everything else automatically on startup.

---

## What you need and where to find it

| What | Starts with | Where |
|---|---|---|
| **Conversations Service SID** | `IS...` | Conversations → Manage → Services |
| **Messaging Service SID** | `MG...` | Messaging → Services |

These are two different things. A Conversations Service holds the conversation threads.
A Messaging Service is what sends and receives SMS on behalf of your phone number.

---

## Step 1 — Create a Conversations Service

1. Log in to [console.twilio.com](https://console.twilio.com)
2. In the left sidebar click **Conversations**
3. Click **Manage** → **Services**
4. Click **Create new Conversation Service**
5. Give it a name (e.g. `OpenClaw`) and click **Create**
6. You land on the service page — copy the **SID** at the top (`IS...`)

Add it to your `openclaw.json`:
```json
"shared": {
  "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

## Step 2 — Create a Messaging Service

1. In the left sidebar click **Messaging**
2. Click **Services**
3. Click **Create Messaging Service**
4. Give it a name (e.g. `OpenClaw SMS`) and click **Create Messaging Service**
5. On the next screen click **Step 3: Set up integration** (skip sender pool for now)
6. Leave all fields blank and click **Complete Messaging Service Setup**
7. On the service page, copy the **SID** at the top (`MG...`)

Add it to your `openclaw.json` under your phone number account:
```json
"accounts": {
  "+12125551234": {
    "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
}
```

---

## Step 3 — Attach your phone number to the Messaging Service

Your phone number needs to be linked to the Messaging Service you just created.
Do this from the phone number page, not from the Messaging Service.

1. In the left sidebar click **Phone Numbers**
2. Click **Manage** → **Active Numbers**
3. Click your phone number
4. Scroll to **Messaging Configuration**
5. Under **Messaging Service**, click the dropdown and select the service you just
   created (`OpenClaw SMS`)
6. Clear the **"A message comes in"** webhook URL field completely (leave it blank)
7. Click **Save configuration**

> If you had a plain webhook URL set here before, clearing it is important.
> Once the plugin registers Address Configuration on startup, Twilio routes
> all inbound SMS through Conversations instead.

---

## Step 4 — Update openclaw.json

Your full config should look like this:

```json
"channels": {
  "twilio": {
    "enabled": true,
    "shared": {
      "accountSid":             "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "authToken":              "your-auth-token",
      "conversationServiceSid": "ISxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "webhook": {
        "port":    3100,
        "path":    "/sms2",
        "baseUrl": "https://your-public-domain.example.com"
      }
    },
    "accounts": {
      "+12125551234": {
        "name":                "My Line",
        "fromNumber":          "+12125551234",
        "messagingServiceSid": "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "dmPolicy":            "pairing"
      }
    }
  }
}
```

> **`baseUrl` is required.** Without it the plugin cannot register your phone number
> with Twilio Conversations and no inbound messages will arrive.

---

## Step 5 — Restart OpenClaw

Restart OpenClaw. On startup you will see in the logs:

```
[twilio:gateway] Webhook server listening on 0.0.0.0:3100
[twilio:gateway] Address configuration created for +12125551234 → https://your-domain.example.com/sms2
```

This means Twilio now knows to send inbound SMS for your number to your webhook
instead of the old plain SMS handler.

If you see `Address configuration already exists` that is fine — it was already
registered from a previous run.

---

## Step 6 — Verify

1. In the left sidebar click **Conversations**
2. Click **Manage** → **Address Configurations**
3. You should see your phone number listed with:
   - Auto-creation: **Enabled**
   - Webhook URL: your `baseUrl` + path (e.g. `https://your-domain.example.com/sms2`)

If the row is missing, check that `baseUrl` is set and restart OpenClaw again.

---

## Step 7 — Send a test SMS

Send an SMS from any phone to your Twilio number. Check your OpenClaw logs for:

```
[twilio:inbound] onMessageAdded conversationSid=CHxxxxxxxxxx author=+1xxxxxxxxxx
```

That confirms everything is working.

---

## Troubleshooting

**Phone number not appearing in Messaging Service sender pool**
Go to **Phone Numbers → Active Numbers → your number → Messaging Configuration**
and select the Messaging Service from the dropdown there instead.

**No inbound messages after restart**
Confirm Address Configuration was registered (Step 6). If missing, check that
`baseUrl` is set in config and has no trailing slash.

**403 Forbidden on the webhook**
`baseUrl` in your config does not exactly match the URL Twilio is sending to.
No trailing slash, correct scheme (`https://`), correct domain.

**"Could not configure address" in logs**
Credentials wrong, or server has no outbound internet access to reach Twilio API.
