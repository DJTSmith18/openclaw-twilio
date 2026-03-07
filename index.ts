import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { twilioPlugin } from "./src/channel.js";
import { setTwilioRuntime } from "./src/runtime.js";

const plugin = {
  id: "twilio",
  name: "Twilio SMS/MMS/RCS",
  description: "Twilio channel plugin for SMS, MMS, RCS, and Group messaging",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTwilioRuntime(api.runtime);
    api.registerChannel({ plugin: twilioPlugin as ChannelPlugin });
  },
};

export default plugin;
