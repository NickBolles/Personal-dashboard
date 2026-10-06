import { api } from "@/server/http/api";
import { hermesConn, HermesDiscoveryClient } from "@/integrations/hermes/client";

export const GET = api(
  async () => {
    const c = hermesConn();
    const [caps, options] = await Promise.all([HermesDiscoveryClient.capabilities(c), HermesDiscoveryClient.modelOptions(c).catch(() => undefined)]);
    return { features: caps.features, model: options?.model, provider: options?.provider, providers: options?.providers ?? [] };
  },
  { cap: "hermes.chat" },
);
