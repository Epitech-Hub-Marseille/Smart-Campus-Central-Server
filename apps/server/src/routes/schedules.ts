import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import {
  createSchedule,
  deleteSchedule,
  executeSchedule,
  scheduleInput,
  setScheduleEnabled,
  updateSchedule,
} from "../domain/schedules.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { ScheduleModel } from "../models/schedule.js";

/** Scheduled and automatic announcements. Admins and operators only. */
export const schedulesRouter = Router();
schedulesRouter.use(requireRole("admin", "operator"));

const dto = (s: InstanceType<typeof ScheduleModel>) => ({
  id: s.scheduleId,
  name: s.name,
  content: s.content,
  trigger: s.trigger,
  targets: s.targets ?? null,
  enabled: s.enabled,
  nextRunAt: s.nextRunAt ?? null,
  lastRunAt: s.lastRunAt ?? null,
  lastError: s.lastError ?? null,
  runCount: s.runCount,
  createdBy: s.createdByName,
  createdAt: s.createdAt,
});

schedulesRouter.get("/", async (_req, res) => {
  const items = await ScheduleModel.find().sort({ createdAt: -1 }).limit(200);
  res.json({ items: items.map(dto) });
});

schedulesRouter.post("/", async (req, res) => {
  res.status(201).json(dto(await createSchedule(scheduleInput.parse(req.body), req.user!)));
});

schedulesRouter.put("/:id", async (req, res) => {
  res.json(dto(await updateSchedule(String(req.params.id), scheduleInput.parse(req.body), req.user!)));
});

/** Pause or resume without resending the whole definition. */
schedulesRouter.patch("/:id", async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  res.json(dto(await setScheduleEnabled(String(req.params.id), enabled, req.user!)));
});

schedulesRouter.delete("/:id", async (req, res) => {
  await deleteSchedule(String(req.params.id), req.user!);
  res.status(204).end();
});

/** Runs it now for a check, to its configured targets. Does not move the next scheduled run. */
schedulesRouter.post("/:id/run", async (req, res) => {
  const schedule = await ScheduleModel.findOne({ scheduleId: String(req.params.id) });
  if (!schedule) throw new HttpError(404, "Schedule not found");
  if (!schedule.targets) throw new HttpError(400, "This schedule fires on a status change; it has no fixed screens to test on");
  const outcome = await executeSchedule(schedule);
  await recordAudit(req.user!, "schedule.run-now", { type: "schedule", id: schedule.scheduleId }, { ok: outcome.ok });
  if (!outcome.ok) throw new HttpError(400, outcome.error ?? "The run failed");
  res.json(dto((await ScheduleModel.findOne({ scheduleId: schedule.scheduleId }))!));
});
