import { z } from "zod";
import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { listDevices, updateDevice } from "@/server/devices";
import { fcmClientConfig } from "@/server/notifications/fcm";

function requireDevice(deviceId: string | undefined) {
  if (!deviceId) throw new HttpError(403, "device_only", "Only a paired phone can use this endpoint");
  return deviceId;
}

/** The calling phone: its record and the Firebase client config it needs to register for push. */
export const GET = api(({ user }) => {
  const id = requireDevice(user.deviceId);
  const device = listDevices(user.id).find((d) => d.id === id);
  return { device, user: { name: user.name }, push: fcmClientConfig() };
});

const patchSchema = z.object({
  pushToken: z.string().min(10).max(4096).nullable().optional(),
  appVersion: z.string().max(40).optional(),
  name: z.string().min(1).max(80).optional(),
});

export const PATCH = api<z.infer<typeof patchSchema>>(
  ({ user, body }) => {
    updateDevice(requireDevice(user.deviceId), body);
    return { ok: true };
  },
  { body: patchSchema },
);
