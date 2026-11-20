import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import { registry } from "../gateway/registry.js";
import { recordAudit } from "../lib/audit.js";
import { toCsv, type Cell } from "../lib/csvWrite.js";
import { HttpError } from "../lib/errors.js";
import { announcementState, AnnouncementModel } from "../models/announcement.js";
import { AuditLogModel } from "../models/auditLog.js";
import { DeviceModel } from "../models/device.js";
import { EmergencyModel } from "../models/emergency.js";
import { MessageModel } from "../models/message.js";
import { ReservationModel } from "../models/reservation.js";
import { RoomModel } from "../models/room.js";
import { RoomStatusChangeModel } from "../models/roomStatusChange.js";
import { RoomStatusModel } from "../models/roomStatus.js";
import { UserModel } from "../models/user.js";
import { auditFilter, auditQuery } from "./audit.js";

/** Figures for the overview, and CSV exports of what the platform records. Administrators and operators only. */
export const statsRouter = Router();
statsRouter.use(requireRole("admin", "operator"));

const startOfDay = () => new Date(new Date().setHours(0, 0, 0, 0));

statsRouter.get("/overview", async (req, res) => {
  const now = new Date();
  const dayStart = startOfDay();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [devices, pending, roomsByStatus, statuses, announcements, emergencies, reservationsToday, people, activity] = await Promise.all([
    DeviceModel.find({ status: "active" }).select("deviceId name type lastSeenAt"),
    DeviceModel.countDocuments({ status: "pending" }),
    RoomModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    RoomStatusModel.find().select("key label color"),
    AnnouncementModel.find({ status: "active" }).select("expiresAt status"),
    EmergencyModel.countDocuments({ status: "active" }),
    ReservationModel.countDocuments({ status: "active", start: { $lt: dayEnd }, end: { $gt: dayStart } }),
    UserModel.countDocuments({ disabled: { $ne: true } }),
    // Who did what is for administrators: operators do not see the audit log, so they do not see it here either.
    req.user!.role === "admin" ? AuditLogModel.find().sort({ at: -1, _id: -1 }).limit(8) : Promise.resolve([]),
  ]);

  const online = devices.filter((d) => registry.isOnline(d.deviceId));
  const offline = devices.filter((d) => !registry.isOnline(d.deviceId));
  const meta = new Map(statuses.map((s) => [s.key, s]));
  res.json({
    devices: {
      active: devices.length,
      online: online.length,
      pending,
      offline: offline.map((d) => ({ id: d.deviceId, name: d.name || d.deviceId, type: d.type, lastSeenAt: d.lastSeenAt ?? null })),
    },
    rooms: {
      total: roomsByStatus.reduce((n, r) => n + r.count, 0),
      byStatus: roomsByStatus
        .map((r) => ({ key: r._id, label: meta.get(r._id)?.label ?? r._id, color: meta.get(r._id)?.color ?? null, count: r.count }))
        .sort((a, b) => b.count - a.count),
    },
    announcements: { active: announcements.filter((a) => announcementState(a, now.getTime()) === "active").length },
    emergencies: { active: emergencies },
    reservations: { today: reservationsToday },
    people: { total: people },
    activity: activity.map((e) => ({ id: String(e._id), at: e.at, actor: e.actorName, action: e.action, target: `${e.targetType} ${e.targetId}` })),
  });
});

const exportQuery = auditQuery.pick({ from: true, to: true });
/** An export is a spreadsheet, not a backup: a hard cap keeps a request from loading a whole collection. */
const MAX_ROWS = 20_000;

type Dataset = { admin?: boolean; build(range: { from?: Date; to?: Date }): Promise<{ headers: string[]; rows: Cell[][] }> };

const within = (field: string, { from, to }: { from?: Date; to?: Date }) =>
  from || to ? { [field]: { ...(from && { $gte: from }), ...(to && { $lte: to }) } } : {};

const DATASETS: Record<string, Dataset> = {
  devices: {
    async build() {
      const devices = await DeviceModel.find({ status: { $in: ["active", "revoked"] } }).sort({ name: 1 }).limit(MAX_ROWS);
      return {
        headers: ["name", "id", "type", "status", "online", "groups", "last_seen"],
        rows: devices.map((d) => [d.name, d.deviceId, d.type, d.status, registry.isOnline(d.deviceId), d.groups.join(" "), d.lastSeenAt]),
      };
    },
  },
  announcements: {
    async build(range) {
      const items = await AnnouncementModel.find(within("createdAt", range)).sort({ createdAt: -1 }).limit(MAX_ROWS);
      return {
        headers: ["created", "kind", "title", "text", "priority", "state", "screens", "expires", "author"],
        rows: items.map((a) => [a.createdAt, a.kind, a.title, a.text, a.priority, announcementState(a), a.deviceIds.length, a.expiresAt, a.createdByName]),
      };
    },
  },
  reservations: {
    async build(range) {
      const items = await ReservationModel.find(within("start", range))
        .sort({ start: -1 })
        .limit(MAX_ROWS)
        .populate({ path: "room", select: "code building", populate: { path: "building", select: "name" } });
      return {
        headers: ["start", "end", "building", "room", "title", "organizer", "status", "source"],
        rows: items.map((r) => {
          const room = r.room as unknown as { code?: string; building?: { name?: string } } | null;
          return [r.start, r.end, room?.building?.name, room?.code, r.title, r.organizerName, r.status, r.source ?? "console"];
        }),
      };
    },
  },
  "room-statuses": {
    async build(range) {
      const items = await RoomStatusChangeModel.find(within("at", range))
        .sort({ at: -1 })
        .limit(MAX_ROWS)
        .populate({ path: "room", select: "code building", populate: { path: "building", select: "name" } });
      return {
        headers: ["at", "building", "room", "from", "to", "by"],
        rows: items.map((c) => {
          const room = c.room as unknown as { code?: string; building?: { name?: string } } | null;
          return [c.at, room?.building?.name, room?.code, c.from, c.toLabel, c.actorName];
        }),
      };
    },
  },
  emergencies: {
    async build(range) {
      const items = await EmergencyModel.find(within("createdAt", range)).sort({ createdAt: -1 }).limit(MAX_ROWS);
      return {
        headers: ["started", "kind", "title", "test", "status", "screens", "started_by", "cleared", "cleared_by"],
        rows: items.map((e) => [e.createdAt, e.kind, e.title, e.testMode, e.status, e.deviceIds.length, e.startedByName, e.clearedAt, e.clearedByName]),
      };
    },
  },
  messages: {
    async build(range) {
      const items = await MessageModel.find(within("createdAt", range)).sort({ createdAt: -1 }).limit(MAX_ROWS);
      return {
        headers: ["sent", "subject", "priority", "sender", "recipients", "read"],
        rows: items.map((m) => [m.createdAt, m.subject, m.priority, m.senderName, m.recipients.length, m.recipients.filter((r) => r.readAt).length]),
      };
    },
  },
  audit: {
    admin: true,
    async build(range) {
      const items = await AuditLogModel.find(auditFilter(range)).sort({ at: -1, _id: -1 }).limit(MAX_ROWS);
      return {
        headers: ["at", "actor", "action", "target_type", "target_id", "details"],
        rows: items.map((e) => [e.at, e.actorName, e.action, e.targetType, e.targetId, JSON.stringify(e.meta ?? {})]),
      };
    },
  },
};

export const DATASET_NAMES = Object.keys(DATASETS);

statsRouter.get("/datasets", (req, res) => {
  res.json({ items: DATASET_NAMES.filter((n) => !DATASETS[n]!.admin || req.user!.role === "admin") });
});

statsRouter.get("/export/:dataset", async (req, res) => {
  const name = String(req.params.dataset);
  const dataset = Object.hasOwn(DATASETS, name) ? DATASETS[name] : undefined;
  if (!dataset) throw new HttpError(404, "Unknown dataset");
  if (dataset.admin && req.user!.role !== "admin") throw new HttpError(403, "Forbidden");

  const range = exportQuery.parse(req.query);
  const { headers, rows } = await dataset.build(range);
  await recordAudit(req.user!, "stats.export", { type: "dataset", id: name }, { rows: rows.length });
  res
    .type("text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="smartcampus-${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(toCsv(headers, rows));
});
