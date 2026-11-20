import type { DeviceRegistry } from "../gateway/registry.js";
import { recordAudit } from "../lib/audit.js";
import { DeviceModel } from "../models/device.js";
import { notifyManagers } from "./messages.js";

const label = (d: { name?: string | null; deviceId: string }) => d.name || d.deviceId;

/**
 * Raises an alert when a device stays offline. A device that drops and comes back within `graceMs` (a Wi-Fi blip, a restart,
 * or the server itself restarting) raises nothing: the alert is for a screen that is really gone. The alert is written to the
 * audit log and sent to administrators and operators as a message, so it is still there when nobody had the console open.
 * When the device comes back, that is recorded as well.
 */
export function watchDevices(registry: DeviceRegistry, graceMs: number) {
  const timers = new Map<string, NodeJS.Timeout>();
  /** Devices an alert was raised for and that have not come back yet. */
  const alerted = new Set<string>();

  const arm = (deviceId: string) => {
    if (timers.has(deviceId) || alerted.has(deviceId)) return;
    const timer = setTimeout(() => {
      timers.delete(deviceId);
      void raise(deviceId);
    }, graceMs);
    timer.unref();
    timers.set(deviceId, timer);
  };

  async function raise(deviceId: string) {
    try {
      if (registry.isOnline(deviceId)) return;
      const device = await DeviceModel.findOne({ deviceId, status: "active" });
      if (!device) return; // revoked or deleted on purpose: not an incident
      alerted.add(deviceId);
      const minutes = Math.max(1, Math.round(graceMs / 60_000));
      await recordAudit(null, "device.offline", { type: "device", id: deviceId }, { name: label(device), lastSeenAt: device.lastSeenAt ?? null });
      await notifyManagers(
        `${label(device)} is offline`,
        `The ${device.type} device “${label(device)}” has not been connected for more than ${minutes} minute${minutes === 1 ? "" : "s"}.${
          device.lastSeenAt ? ` Last contact: ${device.lastSeenAt.toISOString()}.` : ""
        }`,
        "important",
      );
    } catch (err) {
      console.error("device alert failed", err instanceof Error ? err.message : err);
    }
  }

  const onOnline = async (deviceId: string) => {
    const timer = timers.get(deviceId);
    if (timer) clearTimeout(timer);
    timers.delete(deviceId);
    if (!alerted.delete(deviceId)) return;
    try {
      const device = await DeviceModel.findOne({ deviceId });
      const name = device ? label(device) : deviceId;
      await recordAudit(null, "device.online", { type: "device", id: deviceId }, { name });
      await notifyManagers(`${name} is back online`, `The device “${name}” is connected again.`, "info");
    } catch (err) {
      console.error("device alert failed", err instanceof Error ? err.message : err);
    }
  };

  registry.on("offline", arm);
  registry.on("online", onOnline);

  // After a server restart no device is connected yet. Each active one gets the grace period to dial back in.
  void DeviceModel.find({ status: "active" })
    .select("deviceId")
    .then((devices) => devices.forEach((d) => !registry.isOnline(d.deviceId) && arm(d.deviceId)))
    .catch((err) => console.error("device alert start failed", err instanceof Error ? err.message : err));

  return () => {
    registry.off("offline", arm);
    registry.off("online", onOnline);
    timers.forEach(clearTimeout);
    timers.clear();
  };
}
