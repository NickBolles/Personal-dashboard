import { api } from "@/server/http/api";
import { listDevices } from "@/server/devices";

export const GET = api(({ user }) => ({ devices: listDevices(user.id), current: user.deviceId ?? null }));
