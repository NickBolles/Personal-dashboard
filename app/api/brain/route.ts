import { api } from "@/server/http/api";
import { hermesConn, HermesAutomationClient, HermesDiscoveryClient } from "@/integrations/hermes/client";
import { resolveIntegration } from "@/integrations/store";

export const dynamic = "force-dynamic";

const settle = async <T>(p: Promise<T>) => {
  try {
    return { ok: true as const, value: await p };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
};

/** Bot brain v1: status, capabilities, skills, toolsets and cron jobs. Memory contents are not exposed by the Hermes API. */
export const GET = api(async () => {
  const c = hermesConn();
  const [health, caps, skills, toolsets, jobs] = await Promise.all([
    settle(HermesDiscoveryClient.health(c)),
    settle(HermesDiscoveryClient.capabilities(c)),
    settle(HermesDiscoveryClient.skills(c)),
    settle(HermesDiscoveryClient.toolsets(c)),
    settle(HermesAutomationClient.list(c)),
  ]);
  return {
    health,
    memoryWriteApi: caps.ok ? Boolean(caps.value.features.memory_write_api) : false,
    skills: skills.ok ? { ok: true, items: skills.value.data } : skills,
    toolsets: toolsets.ok ? { ok: true, items: toolsets.value.data } : toolsets,
    jobs: jobs.ok ? { ok: true, items: jobs.value.jobs } : jobs,
    dashboardUrl: resolveIntegration("hermes").config.dashboardUrl || undefined,
  };
});
