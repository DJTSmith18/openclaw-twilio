import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { getThreadByConversationSid, getConversationBySid } from "./db.js";
import { lookupContact } from "./conversation-store.js";
import { normalizeE164 } from "./normalize.js";

/**
 * Build the twilio_get_conversation_context agent tool.
 *
 * Registered via api.registerTool() so it is available to the agent.
 * Queries the local twilio_conversations table by conversation_sid.
 */
export function createConversationContextTool(): AnyAgentTool {
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
        limit: {
          type: "number",
          description:
            "Maximum number of recent messages to return (default 20, max 50).",
        },
      },
      required: ["conversationSid"],
    } as any,

    execute: async (_toolCallId: string, args: unknown) => {
      const { conversationSid, limit: rawLimit } =
        (args as { conversationSid?: string; limit?: number }) ?? {};

      if (!conversationSid) {
        return {
          content: [
            { type: "text", text: "Error: conversationSid is required." },
          ],
        };
      }

      const limit = Math.min(Math.max(rawLimit ?? 20, 1), 50);

      // Query messages directly by conversation_sid
      const rows = await getThreadByConversationSid(conversationSid, limit);

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

      // Look up conversation metadata for group participant info
      const convMeta = await getConversationBySid(conversationSid);
      const chatType = convMeta?.chatType ?? "direct";
      const participants = convMeta?.participants;

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
}): string {
  const { conversationSid, chatType } = params;
  return [
    `📋 CONVERSATION CONTEXT TOOL`,
    `To retrieve recent message history for this ${chatType} conversation, call the tool:`,
    `  Tool: twilio_get_conversation_context`,
    `  Parameters: { "conversationSid": "${conversationSid}" }`,
    `This is useful when you need to recall earlier messages or context.`,
  ].join("\n");
}
