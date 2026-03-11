import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { createTwilioConversationStore, lookupContact } from "./conversation-store.js";
import { getConversationBySid } from "./db.js";
import { normalizeE164 } from "./normalize.js";

/**
 * Build the twilio_get_conversation_context agent tool.
 *
 * The agent calls this tool to retrieve recent message history for the
 * current conversation.  The inbound payload includes the ConversationSid
 * and DID so the agent knows which conversation to query.
 */
export function createConversationContextTool(): ChannelAgentTool {
  return {
    label: "Twilio Conversation Context",
    name: "twilio_get_conversation_context",
    description:
      "Retrieve recent message history for a Twilio SMS/MMS conversation. " +
      "Use this to recall what was previously said in the conversation.",
    parameters: {
      type: "object",
      properties: {
        conversationSid: {
          type: "string",
          description:
            "The Twilio ConversationSid (CH...) to retrieve history for. " +
            "This is provided in the inbound message context.",
        },
        did: {
          type: "string",
          description:
            "Our phone number (DID) for this conversation. " +
            "This is provided in the inbound message context.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of recent messages to return (default 20, max 50).",
        },
      },
      required: ["conversationSid", "did"],
    } as any,

    execute: async (_toolCallId: string, args: unknown) => {
      const { conversationSid, did, limit: rawLimit } =
        (args as { conversationSid?: string; did?: string; limit?: number }) ?? {};

      if (!conversationSid || !did) {
        return {
          content: [
            { type: "text", text: "Error: conversationSid and did are required." },
          ],
        };
      }

      const limit = Math.min(Math.max(rawLimit ?? 20, 1), 50);

      // Look up conversation metadata from the conversation map
      const convMeta = await getConversationBySid(conversationSid);

      // Determine chat type and peer info from DB cache (if available)
      const chatType = convMeta?.chatType ?? "direct";
      const peerId = convMeta?.peerId;
      const participants = convMeta?.participants;
      const accountId = convMeta?.accountId ?? "default";

      const store = createTwilioConversationStore({ accountId });

      // For direct conversations, query by DID + peer phone number
      // For group conversations, query by DID only (all participants)
      const phoneNumber =
        chatType === "direct" && peerId ? peerId : undefined;

      const rows = await store.getThread({
        did,
        phoneNumber,
        limit,
      });

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No messages found for conversation ${conversationSid}.`,
            },
          ],
        };
      }

      // Format messages in chronological order (oldest first)
      const chronological = [...rows].reverse();

      const contactCache = new Map<string, string>();

      const lines: string[] = [
        `--- Conversation History (${chatType}, last ${chronological.length} messages) ---`,
      ];

      if (chatType === "group" && participants && participants.length > 0) {
        lines.push(`Participants: ${participants.join(", ")}`);
      }
      lines.push("");

      for (const row of chronological) {
        const ts = row.created_at
          ? new Date(row.created_at).toLocaleString()
          : "?";
        const dir = row.direction === "inbound" ? "←" : "→";

        // Resolve sender label
        let sender: string;
        if (row.direction === "outbound") {
          sender = "You";
        } else {
          const phone = normalizeE164(row.phone_number) ?? row.phone_number;
          if (contactCache.has(phone)) {
            sender = contactCache.get(phone)!;
          } else {
            try {
              const info = await lookupContact(phone);
              const name = (info as any)?.name;
              if (name) {
                sender = `${name} (${phone})`;
                contactCache.set(phone, sender);
              } else {
                sender = phone;
                contactCache.set(phone, sender);
              }
            } catch {
              sender = phone;
            }
          }
        }

        const msg = row.message || (row.media_url ? "[media]" : "[empty]");
        lines.push(`[${ts}] ${dir} ${sender}: ${msg}`);
        if (row.media_url) {
          lines.push(`  📎 ${row.media_url}`);
        }
      }

      lines.push("");
      lines.push("--- End of History ---");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  };
}

/**
 * Build the context tool instructions block to include in the inbound
 * message payload so the agent knows how to retrieve conversation history.
 */
export function buildConversationContextToolHint(params: {
  conversationSid: string;
  chatType: "direct" | "group";
  did: string;
}): string {
  const { conversationSid, chatType, did } = params;
  return [
    `📋 CONVERSATION CONTEXT TOOL`,
    `To retrieve recent message history for this ${chatType} conversation, call the tool:`,
    `  Tool: twilio_get_conversation_context`,
    `  Parameters: { "conversationSid": "${conversationSid}", "did": "${did}" }`,
    `This is useful when you need to recall earlier messages or context.`,
  ].join("\n");
}
