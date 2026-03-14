import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface PendingTask {
  id: number;
  title: string;
  status: string;
  priority: number;
  assigned_to_agent?: string;
  description?: string;
  note?: string;
}

function httpGetJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300))
          return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

export interface TaskSystemClient {
  getPendingResponses(phone: string, conversationSid?: string): Promise<PendingTask[]>;
}

export function createTaskClient(
  cfg: OpenClawConfig,
): TaskSystemClient | null {
  const taskCfg = (cfg as any)?.plugins?.entries?.["task-system"]?.config
    ?.webUI;
  if (!taskCfg || taskCfg.enabled === false) return null;

  const port = taskCfg.port || 18790;
  const token = taskCfg.authToken || "";
  let available: boolean | null = null; // null=untested, true/false=tested

  return {
    async getPendingResponses(phone: string, conversationSid?: string): Promise<PendingTask[]> {
      if (available === false) return [];
      // Normalize E.164 to 10-digit for task system matching
      const phone10 = phone.replace(/\D/g, "").slice(-10);
      if (phone10.length < 10 && !conversationSid) return [];
      try {
        const headers: Record<string, string> = token
          ? { Authorization: `Bearer ${token}` }
          : {};
        const params = new URLSearchParams();
        if (phone10.length >= 10) params.set("contact", phone10);
        if (conversationSid) params.set("conversation", conversationSid);
        const result = (await httpGetJson(
          `http://127.0.0.1:${port}/dashboard/api/tasks/pending-responses?${params.toString()}`,
          headers,
          3000,
        )) as any;
        available = true;
        return result?.tasks || [];
      } catch {
        if (available === null) available = false;
        return [];
      }
    },
  };
}
