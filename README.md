# OpenClaw Twilio Channel Plugin

SMS, MMS, RCS, and Group messaging channel for [OpenClaw](https://github.com/openclaw) via the **Twilio Conversations API**.

## Features

- **Twilio Conversations API** — Stable session IDs, native group fan-out, server-side message history
- **Multi-DID support** — Each phone number is a separate account, bindable to different agents
- **SMS / MMS / RCS** — Send and receive text, images, video, and rich content
- **Group MMS** — Full group threading with Twilio-managed `CH...` session IDs
- **Auto Address Configuration** — On startup, each DID is automatically registered with the Conversations API via Address Configuration
- **Shared SQLite database** — Centralized contacts table compatible with the [voipms-sms](https://github.com/DJTSmith18/openclaw-voipms-sms) plugin
- **Conversation history** — Full inbound/outbound audit log in `twilio_conversations`
- **Contact enrichment** — Automatic contact lookup on inbound messages
- **Webhook security** — Twilio HMAC-SHA1 signature validation on every request
- **Per-DID access control** — `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom` per phone number
- **RCS with SMS fallback** — Automatic RCS delivery via Messaging Services
- **Interactive scripts** — Installer, management console, test suite, and uninstaller

## How It Works

This plugin uses the **Twilio Conversations API** rather than the legacy Messages (SMS) API. The key difference:

| | Legacy Messages API | Conversations API (this plugin) |
|---|---|---|
| Session IDs | Locally-generated UUIDs | Twilio-managed `CH...` ConversationSids |
| Group detection | Jaccard similarity + Event Streams polling | Native — participant count via `participants.list()` |
| Group outbound | One SMS per recipient in a loop | Single `messages.create()` → Twilio fans out |
| Inbound webhook | Raw SMS POST per message | `onMessageAdded` on the Conversations event stream |
| Session stability | Breaks when group membership changes | Stable `CH...` SID across all participant changes |

### Inbound Flow

1. Twilio receives an SMS/MMS to one of your DIDs
2. Address Configuration auto-creates or reuses a `Conversation` and fires `onMessageAdded`
3. The plugin receives the webhook: `ConversationSid`, `Author` (sender), `MessagingBinding.ProxyAddress` (your DID)
4. Account is resolved by matching `MessagingServiceSid` in the payload against per-DID config
5. Conversation type is determined from DB cache or by calling `participants.list()`:
   - 1 remote SMS participant → `direct`
   - 2+ remote SMS participants → `group`
6. Session key is built, access control is applied, and the message is dispatched to the bound agent

### Outbound Flow

- **Reply to existing conversation**: `ConversationSid` is already known — one `messages.create()` call
- **Proactive send to known number**: DB lookup → found → post message to cached conversation
- **Proactive send to new number**: Conversation is created, phone added as SMS participant, message sent
- **Group reply**: Single `messages.create()` → Twilio delivers to all participants

### Session Keys

| Type | Key Format |
|------|-----------|
| Direct | `twilio:{accountId}:direct:{senderE164}` |
| Group  | `twilio:{accountId}:group:{conversationSid}` |

---

## Requirements

- Node.js >= 18
- OpenClaw installed and configured (`~/.openclaw/openclaw.json`)
- A Twilio account with at least one phone number
- A **Twilio Messaging Service** (`MG...`) — required for Conversations API outbound
- `jq` (for installer scripts)
- `sqlite3` CLI (auto-installed by installer if missing)

---

## Quick Start

### Option 1 — Remote install (recommended)

One command on the destination machine. No manual cloning or tarball extraction required.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh)
```

> **Note:** Use `bash <(curl ...)` — not `curl ... | bash`. Process substitution keeps stdin connected to your terminal so the interactive prompts work correctly.

The script will:
1. Detect your OpenClaw installation (prompts for the base directory if not found at `~/.openclaw`)
2. Download and extract the plugin into `<openclaw-base>/extensions/twilio`
3. Launch the interactive installer automatically

**Upgrade an existing install** (pulls latest code + updates deps, preserves all config):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --upgrade
```

The script also auto-detects an existing install — if `channels.twilio` is already present in `openclaw.json` it will upgrade automatically without prompting.

**Force full reconfiguration** on an existing install:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --reconfigure
```

**Pin to a specific branch or tag:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --branch v1.1.0
```

**Install to a custom directory:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-twilio/main/scripts/remote-install.sh) --dir /opt/openclaw/extensions/twilio
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
2. Phone number (DID) setup — one or more numbers, each with its Messaging Service SID
3. Webhook configuration (port, path, public base URL)
4. Access policies (pairing, allowlist, open) per DID
5. Agent bindings (which agent handles which DID)
6. Optional Conversation Service SID (shared across all DIDs)
7. Database setup (shared SQLite with voipms-sms detection)
8. Dependency installation

---

## Configuration

The plugin stores its configuration in `~/.openclaw/openclaw.json` under `channels.twilio`.

### Multi-DID Setup

```jsonc
{
  "channels": {
    "twilio": {
      "enabled": true,

      // Shared credentials and infrastructure (all DIDs use the same Twilio account)
      "shared": {
        "accountSid": "AC...",
        "authToken": "...",
        "dbPath": "~/.openclaw/shared/sms.db",

        // Optional: scope all conversations to a specific Conversations Service
        "conversationServiceSid": "IS...",

        "contactLookup": {
          "table": "contacts",
          "phoneColumn": "phone",
          "phoneMatch": "like",
          "displayName": "name"
        },
        "webhook": {
          "port": 3100,
          "path": "/conversations/events",
          "baseUrl": "https://your-domain.com"   // required for Address Configuration + HMAC validation
        }
      },

      // Per-DID accounts — each key is an E.164 phone number (your Twilio DID)
      "accounts": {
        "+12125551234": {
          "name": "Support Line",
          "messagingServiceSid": "MG...",        // required for outbound via Conversations API
          "dmPolicy": "pairing",
          "allowFrom": ["+19175551234"],
          "groupPolicy": "allowlist",
          "rcs": { "enabled": true, "fallbackToSms": true }
        },
        "+14155559876": {
          "name": "Sales Line",
          "messagingServiceSid": "MG...",
          "dmPolicy": "open",
          "groupPolicy": "open"
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

For a simple single-number setup, skip the `accounts` block and put per-DID fields directly in the channel config:

```jsonc
{
  "channels": {
    "twilio": {
      "enabled": true,
      "shared": {
        "accountSid": "AC...",
        "authToken": "...",
        "fromNumber": "+12125551234",
        "messagingServiceSid": "MG...",
        "webhook": {
          "port": 3100,
          "path": "/conversations/events",
          "baseUrl": "https://your-domain.com"
        }
      },
      "dmPolicy": "pairing",
      "allowFrom": ["*"]
    }
  }
}
```

### Key Config Fields

| Field | Location | Description |
|-------|----------|-------------|
| `accountSid` | `shared` | Twilio Account SID (`AC...`) |
| `authToken` | `shared` | Twilio Auth Token |
| `dbPath` | `shared` | SQLite database file path |
| `webhook.baseUrl` | `shared` | Public HTTPS base URL — **required** for Address Configuration and signature validation |
| `webhook.port` | `shared` | Local port to listen on (default: `3100`) |
| `webhook.path` | `shared` | Webhook path (default: `/conversations/events`) |
| `conversationServiceSid` | `shared` | Optional Twilio Conversations Service SID (`IS...`) — shared across all DIDs |
| `messagingServiceSid` | per-DID account | Twilio Messaging Service SID (`MG...`) for this DID — used for outbound |
| `dmPolicy` | per-DID account | DM access policy (`pairing`, `allowlist`, `open`, `disabled`) |
| `allowFrom` | per-DID account | Allowlist of sender phone numbers (used with `allowlist` or `pairing` policy) |
| `groupPolicy` | per-DID account | Group access policy (`allowlist`, `open`, `disabled`) |
| `groupAllowFrom` | per-DID account | Allowlist for group participants |
| `rcs` | per-DID account | RCS config: `{ enabled: true, fallbackToSms: true }` |

### Environment Variables

| Variable | Fallback for | Scope |
|----------|-------------|-------|
| `TWILIO_ACCOUNT_SID` | `shared.accountSid` | Shared |
| `TWILIO_AUTH_TOKEN` | `shared.authToken` | Shared |
| `TWILIO_FROM_NUMBER` | `shared.fromNumber` | Default account only |
| `TWILIO_MESSAGING_SERVICE_SID` | `shared.messagingServiceSid` | Default account only |
| `TWILIO_DB_PATH` | `shared.dbPath` | Database location |

---

## Multi-DID Architecture

Each Twilio phone number (DID) is an account:

- **Account ID** = the E.164 phone number (e.g., `+12125551234`)
- **Shared credentials** — `accountSid`, `authToken`, `dbPath`, webhook config, and `conversationServiceSid` live under `shared`
- **Per-DID config** — each account in the `accounts` map has its own `messagingServiceSid`, `dmPolicy`, `allowFrom`, `groupPolicy`, etc.
- **Single webhook server** — one Express server handles all DIDs; `MessagingBinding.ProxyAddress` in the payload routes to the correct account
- **Agent bindings** — each DID maps to a different agent via the `bindings` array

### Inbound Routing

```
Phone sends SMS to +12125551234
  → Twilio Conversations onMessageAdded webhook
  → Express handler validates X-Twilio-Signature
  → MessagingServiceSid matches account "+12125551234"
  → chatType resolved (direct or group)
  → Session key: twilio:+12125551234:direct:+19175551234
  → binding → agentId="support"
```

### Address Configuration (Auto-Setup)

On startup, when `shared.webhook.baseUrl` is set, the plugin automatically calls `client.conversations.v1.addressConfigurations.create()` for each DID. This tells Twilio to:

- Auto-create a `Conversation` when a new SMS arrives at that DID
- Fire `onMessageAdded` to your webhook URL for every message in that conversation

This is idempotent — safe to call on every restart. If the address is already configured, the API returns a conflict which is silently ignored.

---

## Database

The plugin uses a shared SQLite database for contacts, conversation history, and conversation mapping. The schema is designed to be compatible with the [voipms-sms](https://github.com/DJTSmith18/openclaw-voipms-sms) plugin.

### Contacts Table

```sql
CREATE TABLE contacts (
  phone TEXT PRIMARY KEY,   -- E.164 or last-10-digits (voipms-compatible)
  name  TEXT,
  email TEXT
);
```

The installer detects if voipms-sms is already installed and offers to share its database. If not, it creates a new database with a voipms-compatible schema.

### Conversation History Table

```sql
CREATE TABLE twilio_conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number  TEXT    NOT NULL,       -- Contact phone or ConversationSid
  did           TEXT    NOT NULL,       -- Twilio DID that sent/received
  account_id    TEXT    NOT NULL,       -- Resolved account ID
  agent         TEXT,                   -- Agent ID handling this DID
  direction     TEXT    NOT NULL,       -- 'inbound' or 'outbound'
  message       TEXT    NOT NULL,       -- Message body
  media_url     TEXT,                   -- MMS media URL
  message_sid   TEXT,                   -- Twilio message SID (IM... for Conversations)
  chat_type     TEXT    DEFAULT 'direct', -- 'direct' or 'group'
  status        TEXT,                   -- Delivery status
  context       TEXT,                   -- Context tag
  created_at    TEXT    DEFAULT (datetime('now'))
);
```

### Conversation Map Table

Caches `ConversationSid → account/type/participants` so subsequent messages in the same conversation skip the `participants.list()` API call.

```sql
CREATE TABLE twilio_conversation_map (
  conversation_sid TEXT    PRIMARY KEY,      -- CH... ConversationSid
  account_id       TEXT    NOT NULL,         -- Resolved account (DID)
  chat_type        TEXT    NOT NULL,         -- 'direct' or 'group'
  peer_id          TEXT,                     -- E.164 for direct; NULL for group
  participants     TEXT,                     -- JSON string[] of participant phones
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
-- Fast reverse-lookup: given account + peer phone, find the ConversationSid
CREATE UNIQUE INDEX idx_tcm_account_peer
  ON twilio_conversation_map (account_id, peer_id)
  WHERE peer_id IS NOT NULL;
```

### voipms-sms Compatibility Tables

The installer also pre-creates these tables so voipms-sms can use the same database:

- `sms_threads` — Thread logging (matching voipms-sms schema exactly)
- `sms_language_preferences` — Per-contact language preferences

---

## Webhook Setup

The plugin runs an Express server on the configured port (default `3100`).

### Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/conversations/events` | POST | Twilio Conversations `onMessageAdded` webhook (path configurable) |
| `/sms/status` | POST | Delivery status callbacks |
| `/health` | GET | Health check — returns `{ "status": "ok", "channel": "twilio" }` |

### Twilio Console Configuration

Address Configuration is set up **automatically** on startup when `shared.webhook.baseUrl` is configured. No manual Twilio Console steps are required for inbound routing.

If you prefer to configure manually:

1. Go to **Conversations** > **Manage** > **Address Configuration**
2. Add each DID phone number as an address
3. Set the webhook URL to `https://your-domain.com/conversations/events`
4. Enable auto-creation with filter `onMessageAdded`

### Signature Validation

When `shared.webhook.baseUrl` is configured, all inbound requests to both the Conversations webhook and the status callback endpoint are validated using Twilio's HMAC-SHA1 `X-Twilio-Signature` header. Requests with missing or invalid signatures are rejected with HTTP 403.

---

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
| `open` | Any participant in a group conversation is accepted |
| `disabled` | Group messaging disabled |

---

## Chat Types

| Type | Description | Session Key |
|------|-------------|-------------|
| `direct` | 1:1 SMS/MMS/RCS conversation | `twilio:{accountId}:direct:{senderE164}` |
| `group` | Group MMS conversation | `twilio:{accountId}:group:{conversationSid}` |

For group conversations, the agent receives a context header indicating the conversation is not private and listing all current participants (with contact names where available).

---

## Scripts

### `scripts/remote-install.sh`

One-liner remote installer and upgrader. Detects OpenClaw, downloads and extracts the plugin, and either upgrades in place or launches `install.sh` for a fresh configuration.

Automatically detects an existing install: if `channels.twilio` is already present in `openclaw.json`, it upgrades code and dependencies without touching configuration. Also handles config migration from older versions.

```bash
# Options
bash scripts/remote-install.sh --branch <branch>   # pin to branch/tag (default: main)
bash scripts/remote-install.sh --dir <path>         # custom plugin directory
bash scripts/remote-install.sh --upgrade            # force upgrade mode (skip prompts)
bash scripts/remote-install.sh --reconfigure        # force full interactive reconfiguration
```

### `scripts/install.sh`

Interactive installer that configures credentials, DIDs (with Messaging Service SIDs), webhooks, policies, agent bindings, conversation service, and the SQLite database.

```bash
bash scripts/install.sh
```

### `scripts/manage.sh`

TUI management console for post-install changes:

```bash
bash scripts/manage.sh
```

Options include: credential management, DID CRUD (add/edit/remove DIDs and their Messaging Service SIDs), webhook settings, per-DID DM/group policies, agent bindings, RCS settings, Conversation Service SID, status callbacks, database and contacts management, and config viewer.

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

---

## File Structure

```
twilio/
├── index.ts                      # Plugin entry point
├── package.json                  # Dependencies + openclaw metadata
├── scripts/
│   ├── remote-install.sh         # curl-friendly remote installer / upgrader
│   ├── install.sh                # Interactive installer
│   ├── manage.sh                 # TUI management console
│   ├── uninstall.sh              # Clean removal
│   └── test.sh                   # Connectivity + DB tests
└── src/
    ├── channel.ts                # ChannelPlugin definition (multi-account)
    ├── accounts.ts               # Multi-DID account resolution
    ├── outbound.ts               # ChannelOutboundAdapter (sendText, sendMedia)
    ├── send.ts                   # Conversations API send + proactive conversation creation
    ├── monitor.ts                # Express webhook server + Address Configuration setup
    ├── inbound.ts                # onMessageAdded handler, account/type resolution, access control
    ├── status-callback.ts        # Delivery status webhook handler
    ├── onboarding.ts             # ChannelOnboardingAdapter (openclaw setup wizard)
    ├── runtime.ts                # PluginRuntime holder (get/set)
    ├── credentials.ts            # Credential resolution (config → env fallback)
    ├── db.ts                     # SQLite init + conversation map + history helpers
    ├── conversation-store.ts     # Conversation references + history + contacts
    ├── normalize.ts              # E.164 phone number normalization
    └── types.ts                  # Shared type definitions
```

---

## Capabilities

```typescript
capabilities: {
  chatTypes: ["direct", "group"],
  polls: false,
  threads: false,
  media: true,
}
```

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for non-commercial use.
Commercial use requires a separate license from the author.
