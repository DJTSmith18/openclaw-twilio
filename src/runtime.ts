import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTwilioRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTwilioRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Twilio runtime not initialized");
  }
  return runtime;
}
