# OpenClaw Twilio Channel Plugin

SMS, MMS, RCS, and Group messaging channel for [OpenClaw](https://github.com/openclaw) via the Twilio API.

## Features

- **Multi-DID support** — Each Twilio phone number is a separate account, bindable to different agents
- **SMS / MMS / RCS** — Send and receive text, images, video, and rich content
- **Group MMS** — Group messaging with separate session tracking
- **Shared SQLite database** — Centralized contacts table compatible with the [voipms-sms](https://github.com/DJTSmith18/openclaw-voipms-sms) plugin
- **Conversation history** — Full inbound/outbound audit log in `twilio_conversations`
- **Contact enrichment** — Automatic contact lookup on inbound messages
- **Webhook security** — Twilio HMAC-SHA1 signature validation
- **Per-DID access control** — `dmPolicy`, `allowFrom`, `groupPolicy` per phone number
- **RCS with SMS fallback** — Automatic RCS delivery via Messaging Services
- **Interactive scripts** — Installer, management console, test suite, and uninstaller

## Requirements

- Node.js >= 18
- OpenClaw installed and configured (`~/.openclaw/openclaw.json`)
- A Twilio account with at least one phone number
- `jq` (for installer scripts)
- `sqlite3` CLI (auto-installed by installer if missing)

## Quick Start

### Option 1 — Remote install (recommended)

One command on the destination machine. No manual cloning or tarball extraction required.

```bash
curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash
```

The script will:
1. Detect your OpenClaw installation (prompts for the base directory if not found at `~/.openclaw`)
2. Clone the repository into `<openclaw-base>/extensions/twilio`
3. Launch the interactive installer automatically

**Upgrade an existing install** (pulls latest code + updates deps, preserves all config):

```bash
curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash -s -- --upgrade
```

The script also auto-detects an existing install — if `channels.twilio` is already present in `openclaw.json` it will upgrade automatically without prompting.

**Force full reconfiguration** on an existing install:

```bash
curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash -s -- --reconfigure
```

**Pin to a specific branch or tag:**

```bash
curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash -s -- --branch v1.0.1
```

**Install to a custom directory:**

```bash
curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh | bash -s -- --dir /opt/openclaw/extensions/twilio
```

After installation, restart OpenClaw:

```bash
openclaw restart
```

---

### Option 2 — Manual install

```bash
# Clone into your extensions directory
cd ~/.openclaw/extensions
git clone https://github.com/DJTSmith18/openclaw-twilio.git twilio

# Run the interactive installer
cd twilio
bash scripts/install.sh

# Restart OpenClaw
openclaw restart
```

---

The installer will walk you through:

1. Twilio credentials (Account SID + Auth Token)
2. Phone number (DID) setup — one or more numbers
3. Webhook configuration (port, path, public URL)
4. Access policies (pairing, allowlist, open)
5. Agent bindings (which agent handles which DID)
6. Database setup (shared SQLite with voipms-sms detection)
7. Dependency installation

## Configuration

The plugin stores its configuration in `~/.openclaw/openclaw.json` under `channels.twilio`:

```jsonc
{
  "channels": {
    "twilio": {
      "enabled": true,
      "accountSid": "AC...",
      "authToken": "...",
      "dbPath": "~/.openclaw/shared/sms.db",
      "contactLookup": {
        "table": "contacts",
        "phoneColumn": "phone",
        "phoneMatch": "like",
        "displayName": "name"
      },
      "webhook": {
        "port": 3100,
        "path": "/sms",
        "statusPath": "/sms/status",
        "baseUrl": "https://your-domain.com"
      },
      "dmPolicy": "pairing",
      "allowFrom": ["+19175551234"],
      "groupPolicy": "allowlist",

      // Multi-DID accounts
      "accounts": {
        "+12125551234": {
          "name": "Support Line",
          "fromNumber": "+12125551234",
          "messagingServiceSid": "MG...",
          "dmPolicy": "pairing",
          "allowFrom": ["+19175551234"],
          "rcs": { "enabled": true, "fallbackToSms": true }
        },
        "+14155559876": {
          "name": "Sales Line",
          "fromNumber": "+14155559876",
          "dmPolicy": "open"
        }
      }
    }
  },

  // Bind each DID to an agent
  "bindings": [
    { "agentId": "support", "match": { "channel": "twilio", "accountId": "+12125551234" } },
    { "agentId": "sales",   "match": { "channel": "twilio", "accountId": "+14155559876" } }
  ]
}
```

### Single-DID Setup

For a simple single-number setup, skip the `accounts` block entirely:

```jsonc
{
  "channels": {
    "twilio": {
      "enabled": true,
      "accountSid": "AC...",
      "authToken": "...",
      "fromNumber": "+12125551234",
      "dmPolicy": "pairing",
      "allowFrom": ["*"]
    }
  }
}
```

### Environment Variables

| Variable | Fallback for | Scope |
|----------|-------------|-------|
| `TWILIO_ACCOUNT_SID` | `channels.twilio.accountSid` | Shared |
| `TWILIO_AUTH_TOKEN` | `channels.twilio.authToken` | Shared |
| `TWILIO_FROM_NUMBER` | `channels.twilio.fromNumber` | Default account only |
| `TWILIO_MESSAGING_SERVICE_SID` | `channels.twilio.messagingServiceSid` | Default account only |
| `TWILIO_DB_PATH` | `channels.twilio.dbPath` | Database location |

## Multi-DID Architecture

Each Twilio phone number (DID) becomes an account, following the same pattern as the Telegram channel plugin (where each bot token is an account):

- **Account ID** = the normalized E.164 phone number (e.g., `+12125551234`)
- **Shared credentials** — `accountSid` and `authToken` live at the top level
- **Per-DID config** — each account in the `accounts` map can override `dmPolicy`, `allowFrom`, `groupPolicy`, `rcs`, etc.
- **Single webhook server** — one Express server handles all DIDs; inbound `To` field routes to the correct account
- **Agent bindings** — each DID maps to a different agent via the `bindings` array

### Inbound Routing

```
Phone sends SMS to +12125551234
  -> Twilio POST webhook
  -> Express handler validates signature
  -> To=+12125551234 -> accountId="+12125551234" -> binding -> agentId="support"
```

## Database

The plugin uses a shared SQLite database for contacts and conversation history. The database is designed to be compatible with the [voipms-sms](https://github.com/DJTSmith18/openclaw-voipms-sms) plugin, so both plugins can share the same contacts table.

### Shared Contacts Table

```sql
CREATE TABLE contacts (
  phone TEXT PRIMARY KEY,   -- Last 10 digits (voipms-compatible)
  name  TEXT,
  email TEXT
);
```

The installer detects if voipms-sms is already installed and offers to share its database. If not, it creates a new database with a voipms-compatible schema so voipms-sms can use it later.

### Conversation History Table

```sql
CREATE TABLE twilio_conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number  TEXT    NOT NULL,       -- Contact phone (last 10 digits)
  did           TEXT    NOT NULL,       -- Twilio DID that sent/received
  account_id    TEXT    NOT NULL,       -- Resolved account ID
  agent         TEXT,                   -- Agent ID handling this DID
  direction     TEXT    NOT NULL,       -- 'inbound' or 'outbound'
  message       TEXT    NOT NULL,       -- Message body
  media_url     TEXT,                   -- MMS media URL
  message_sid   TEXT,                   -- Twilio message SID
  chat_type     TEXT    DEFAULT 'direct', -- 'direct' or 'group'
  status        TEXT,                   -- Delivery status
  context       TEXT,                   -- Context tag
  created_at    TEXT    DEFAULT (datetime('now'))
);
```

### voipms-sms Compatibility Tables

The installer also pre-creates these tables so voipms-sms can use the same database:

- `sms_threads` — Thread logging (matching voipms-sms schema exactly)
- `sms_language_preferences` — Per-contact language preferences

## Webhook Setup

The plugin runs an Express webhook server on the configured port (default `3100`).

### Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/sms` | POST | Inbound SMS/MMS webhook (configurable) |
| `/sms/status` | POST | Delivery status callbacks (configurable) |
| `/health` | GET | Health check |

### Twilio Console Configuration

In your [Twilio Console](https://console.twilio.com/), configure each phone number's webhook:

1. Go to **Phone Numbers** > **Manage** > **Active Numbers**
2. Select your number
3. Under **Messaging Configuration**:
   - **A message comes in**: `https://your-domain.com/sms` (HTTP POST)
   - **Status callback URL**: `https://your-domain.com/sms/status` (HTTP POST)

### Signature Validation

When `webhook.baseUrl` is configured, the plugin validates the `X-Twilio-Signature` header on every inbound request using HMAC-SHA1. Requests with missing or invalid signatures are rejected with HTTP 403.

## Access Control

### DM Policies (per-DID)

| Policy | Behavior |
|--------|----------|
| `pairing` | New senders must be approved before messages are processed (default) |
| `allowlist` | Only phone numbers in `allowFrom` can send messages |
| `open` | Accept messages from any phone number |
| `disabled` | Reject all inbound messages |

### Group Policies (per-DID)

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only numbers in `groupAllowFrom` can participate (default) |
| `open` | Any participant in a group MMS is accepted |
| `disabled` | Group messaging disabled |

## Chat Types

| Type | Description | Session Key |
|------|-------------|-------------|
| `direct` | 1:1 SMS/MMS/RCS | `twilio:{accountId}:direct:{senderPhone}` |
| `group` | Group MMS | `twilio:{accountId}:group:{groupId}` |

## Scripts

### `scripts/remote-install.sh`

One-liner remote installer and upgrader. Detects OpenClaw, clones or pulls the repo, and either upgrades in place or launches `install.sh` for a fresh configuration. Intended to be fetched and run via `curl` — see [Quick Start](#quick-start).

Automatically detects an existing install: if `channels.twilio` is already present in `openclaw.json`, it upgrades code and dependencies without touching configuration.

```bash
# Options
bash scripts/remote-install.sh --branch <branch>   # pin to branch/tag (default: main)
bash scripts/remote-install.sh --dir <path>         # custom plugin directory
bash scripts/remote-install.sh --upgrade            # force upgrade mode (skip prompts)
bash scripts/remote-install.sh --reconfigure        # force full interactive reconfiguration
```

### `scripts/install.sh`

Interactive installer that configures credentials, DIDs, webhooks, policies, agent bindings, and the SQLite database.

```bash
bash scripts/install.sh
```

### `scripts/manage.sh`

TUI management console with 11 menu options:

```bash
bash scripts/manage.sh
```

Options include: credential management, DID CRUD, webhook settings, per-DID DM/group policies, agent bindings, RCS settings, status callbacks, database & contacts management, and config viewer.

### `scripts/test.sh`

Comprehensive test suite that validates file structure, JSON configs, openclaw.json integration, dependencies, database tables, Twilio API connectivity, DID validation, and webhook reachability.

```bash
bash scripts/test.sh          # Standard tests
bash scripts/test.sh --live   # Include live SMS send test
```

### `scripts/uninstall.sh`

Clean removal of the plugin from openclaw.json, with optional conversation data deletion.

```bash
bash scripts/uninstall.sh           # Interactive
bash scripts/uninstall.sh --force   # Non-interactive
```

## File Structure

```
twilio/
├── index.ts                      # Plugin entry point
├── openclaw.plugin.json          # Plugin manifest
├── package.json                  # Dependencies + openclaw metadata
├── scripts/
│   ├── remote-install.sh         # curl-friendly remote installer
│   ├── install.sh                # Interactive installer
│   ├── manage.sh                 # TUI management console
│   ├── uninstall.sh              # Clean removal
│   └── test.sh                   # Connectivity + DB tests
└── src/
    ├── channel.ts                # ChannelPlugin definition (multi-account)
    ├── accounts.ts               # Multi-DID account resolution
    ├── outbound.ts               # ChannelOutboundAdapter (sendText, sendMedia)
    ├── send.ts                   # Twilio Messages API (SMS/MMS/RCS/Group)
    ├── monitor.ts                # Express webhook server lifecycle
    ├── inbound.ts                # Inbound webhook handler + contact enrichment
    ├── status-callback.ts        # Delivery status webhook handler
    ├── onboarding.ts             # ChannelOnboardingAdapter (openclaw setup)
    ├── runtime.ts                # PluginRuntime holder (get/set)
    ├── credentials.ts            # Credential resolution (config -> env fallback)
    ├── db.ts                     # SQLite database init + helpers
    ├── conversation-store.ts     # Conversation references + history + contacts
    ├── normalize.ts              # E.164 phone number normalization
    └── types.ts                  # Shared type definitions
```

## Capabilities

```typescript
capabilities: {
  chatTypes: ["direct", "group"],
  polls: false,
  threads: false,
  media: true,
}
```

## License

MIT
