import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import { escapeRegex } from "../lib/http.js";
import { AuditLogModel } from "../models/auditLog.js";

/** The audit log: who did what, and when. Administrators only, and read-only (entries are only ever appended). */
export const auditRouter = Router();
auditRouter.use(requireRole("admin"));

export const auditQuery = z.object({
  action: z.string().trim().max(60).optional(),
  actor: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Shared by the list and the CSV export so both show exactly the same rows. */
export function auditFilter(q: z.infer<typeof auditQuery>) {
  return {
    ...(q.action && { action: { $regex: `^${escapeRegex(q.action)}` } }),
    ...(q.actor && { actorName: { $regex: escapeRegex(q.actor), $options: "i" } }),
    ...((q.from || q.to) && { at: { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) } }),
  };
}

export const auditDto = (e: InstanceType<typeof AuditLogModel>) => ({
  id: String(e._id),
  at: e.at,
  actor: e.actorName,
  action: e.action,
  target: { type: e.targetType, id: e.targetId },
  meta: e.meta ?? {},
});

auditRouter.get("/", async (req, res) => {
  const q = auditQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const filter = auditFilter(q);
  const [items, total, actions] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit),
    AuditLogModel.countDocuments(filter),
    // The kinds of action that exist, for the filter's suggestions.
    AuditLogModel.distinct("action"),
  ]);
  res.json({ items: items.map(auditDto), total, actions: actions.sort() });
});
