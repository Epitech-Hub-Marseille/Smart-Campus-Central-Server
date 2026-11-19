import { ANNOUNCE_PRIORITIES, statusKey, ulid } from "@smartcampus/protocol";
import { z } from "zod";
import { config } from "../config.js";
import { requireTts } from "../infra/tts.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { nextOccurrence } from "../lib/recurrence.js";
import { AnnouncementTemplateModel } from "../models/announcementTemplate.js";
import { DeviceModel } from "../models/device.js";
import { RoomStatusModel } from "../models/roomStatus.js";
import { ScheduleModel } from "../models/schedule.js";
import { createAnnouncement } from "./announcements.js";
import { CHIME_LEVELS, type ChimeLevel } from "../lib/chimes.js";
import { MAX_SPEECH_CHARS, speak } from "./intercom.js";
import { targetsInput, type Targets } from "./targeting.js";

type ScheduleDoc = InstanceType<typeof ScheduleModel>;

/** A run that is this late (server was down) is skipped: "the school closes in 10 minutes" an hour later is wrong. */
export const MISSED_RUN_GRACE_MS = 10 * 60_000;

/** A status trigger does not fire again for the same schedule within this time, so a flapping status cannot flood the screens. */
export const STATUS_TRIGGER_COOLDOWN_MS = 60_000;

const hourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const triggerInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), at: z.coerce.date() }).strict(),
  z.object({ type: z.literal("daily"), time: hourMinute }).strict(),
  z
    .object({
      type: z.literal("weekly"),
      time: hourMinute,
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort()),
    })
    .strict(),
  z.object({ type: z.literal("status"), status: statusKey, roomId: z.string().min(1).max(40).optional() }).strict(),
]);
export type TriggerInput = z.infer<typeof triggerInput>;

const contentInput = z
  .object({
    kind: z.enum(["text", "voice"]),
    title: z.string().trim().max(200).default(""),
    text: z.string().trim().min(1).max(2000),
    priority: z.enum(ANNOUNCE_PRIORITIES).default("info"),
    voice: z.string().trim().max(60).default(""),
    // Voice only: the chime played before the voice, by severity.
    chime: z.enum(CHIME_LEVELS).optional(),
    expiresAfterMinutes: z.number().int().min(1).max(10_080).optional(),
  })
  .strict();

export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    // Either a template (copied now) or the content itself.
    templateId: z.string().min(1).max(40).optional(),
    content: contentInput.optional(),
    expiresAfterMinutes: z.number().int().min(1).max(10_080).optional(),
    trigger: triggerInput,
    targets: targetsInput.optional(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((s) => Boolean(s.templateId) !== Boolean(s.content), { message: "Give either templateId or content", path: ["content"] })
  .refine((s) => s.trigger.type === "status" || s.targets, { message: "targets is required", path: ["targets"] });
export type ScheduleInput = z.infer<typeof scheduleInput>;

type Actor = { id: string; name: string };

/** Next run on the clock, or null when nothing is due (status triggers, finished `once`). */
export function computeNextRun(trigger: TriggerInput | ScheduleDoc["trigger"], from: Date): Date | null {
  if (trigger.type === "once") return trigger.at && trigger.at.getTime() > from.getTime() ? trigger.at : null;
  if (trigger.type === "status") return null;
  const next = nextOccurrence({ type: trigger.type, time: trigger.time!, days: "days" in trigger ? (trigger.days ?? undefined) : undefined }, from.getTime(), config.CAMPUS_TIMEZONE);
  return next === null ? null : new Date(next);
}

async function resolveContent(input: ScheduleInput) {
  if (input.content) return input.content;
  const template = await AnnouncementTemplateModel.findOne({ templateId: input.templateId });
  if (!template) throw new HttpError(400, "Unknown template");
  return {
    kind: template.kind,
    title: template.title,
    text: template.text,
    priority: template.priority,
    voice: template.voice,
    ...(input.expiresAfterMinutes && { expiresAfterMinutes: input.expiresAfterMinutes }),
  };
}

/** Everything that can be wrong with a schedule is refused when it is saved, not when it fires. */
async function assertUsable(content: Awaited<ReturnType<typeof resolveContent>>, trigger: TriggerInput) {
  if (content.kind === "voice") {
    requireTts();
    if (content.text.length > MAX_SPEECH_CHARS) throw new HttpError(400, `content.text: a voice announcement holds at most ${MAX_SPEECH_CHARS} characters`);
    if (content.expiresAfterMinutes) throw new HttpError(400, "content.expiresAfterMinutes: a voice announcement is played once and does not expire");
  }
  if (trigger.type === "once" && trigger.at.getTime() <= Date.now()) throw new HttpError(400, "trigger.at must be in the future");
  if (trigger.type === "status" && !(await RoomStatusModel.exists({ key: trigger.status }))) {
    throw new HttpError(400, `Unknown status "${trigger.status}"`);
  }
}

export async function createSchedule(input: ScheduleInput, actor: Actor) {
  const content = await resolveContent(input);
  await assertUsable(content, input.trigger);
  const schedule = await ScheduleModel.create({
    scheduleId: ulid(),
    name: input.name,
    content,
    trigger: input.trigger,
    targets: input.targets,
    enabled: input.enabled,
    nextRunAt: input.enabled ? computeNextRun(input.trigger, new Date()) : null,
    createdBy: actor.id,
    createdByName: actor.name,
  });
  await recordAudit(actor, "schedule.create", { type: "schedule", id: schedule.scheduleId }, { name: schedule.name, trigger: schedule.trigger.type });
  return schedule;
}

export async function updateSchedule(scheduleId: string, input: ScheduleInput, actor: Actor) {
  const schedule = await ScheduleModel.findOne({ scheduleId });
  if (!schedule) throw new HttpError(404, "Schedule not found");
  const content = await resolveContent(input);
  await assertUsable(content, input.trigger);

  schedule.name = input.name;
  schedule.set("content", content);
  schedule.set("trigger", input.trigger);
  schedule.set("targets", input.targets);
  schedule.enabled = input.enabled;
  schedule.nextRunAt = input.enabled ? computeNextRun(input.trigger, new Date()) : null;
  schedule.set("lastError", undefined);
  await schedule.save();
  await recordAudit(actor, "schedule.update", { type: "schedule", id: scheduleId }, { name: schedule.name, enabled: schedule.enabled });
  return schedule;
}

/** Pausing keeps the schedule; resuming recomputes the next run from now, so a long pause does not replay anything. */
export async function setScheduleEnabled(scheduleId: string, enabled: boolean, actor: Actor) {
  const schedule = await ScheduleModel.findOne({ scheduleId });
  if (!schedule) throw new HttpError(404, "Schedule not found");
  schedule.enabled = enabled;
  schedule.nextRunAt = enabled ? computeNextRun(schedule.trigger, new Date()) : null;
  await schedule.save();
  await recordAudit(actor, enabled ? "schedule.enable" : "schedule.disable", { type: "schedule", id: scheduleId }, { name: schedule.name });
  return schedule;
}

export async function deleteSchedule(scheduleId: string, actor: Actor) {
  const schedule = await ScheduleModel.findOneAndDelete({ scheduleId });
  if (!schedule) throw new HttpError(404, "Schedule not found");
  await recordAudit(actor, "schedule.delete", { type: "schedule", id: scheduleId }, { name: schedule.name });
}

/** Screens of a room, for a status trigger without explicit targets. */
async function targetsOfRoom(roomId: string): Promise<Targets> {
  const devices = await DeviceModel.find({ room: roomId, status: "active", type: { $in: ["door", "display"] } }, { deviceId: 1 });
  if (devices.length === 0) throw new HttpError(400, "No screen is linked to this room");
  return { devices: devices.map((d) => d.deviceId) };
}

/**
 * Sends what the schedule says. The outcome is stored on the schedule (not thrown) because nobody is
 * waiting for a scheduled run: the console shows the last error instead.
 */
export async function executeSchedule(schedule: ScheduleDoc, context: { roomId?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  const actor = { id: schedule.createdBy ?? "system", name: `${schedule.name} (scheduled)` };
  try {
    const targets = (schedule.targets as Targets | undefined) ?? (context.roomId ? await targetsOfRoom(context.roomId) : undefined);
    if (!targets) throw new HttpError(400, "This schedule has no targets");
    const content = schedule.content;
    if (content.kind === "voice") {
      await speak({ text: content.text, voice: content.voice || undefined, title: content.title || undefined, chime: (content.chime as ChimeLevel | undefined) || undefined, targets }, actor);
    } else {
      await createAnnouncement(
        {
          title: content.title || undefined,
          text: content.text,
          priority: content.priority as "info" | "important" | "urgent",
          targets,
          expiresAt: content.expiresAfterMinutes ? new Date(Date.now() + content.expiresAfterMinutes * 60_000) : undefined,
        },
        actor,
      );
    }
    await ScheduleModel.updateOne({ _id: schedule._id }, { $set: { lastRunAt: new Date() }, $unset: { lastError: 1 }, $inc: { runCount: 1 } });
    await recordAudit(actor, "schedule.run", { type: "schedule", id: schedule.scheduleId }, { trigger: schedule.trigger.type });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    await ScheduleModel.updateOne({ _id: schedule._id }, { $set: { lastRunAt: new Date(), lastError: error.slice(0, 300) } });
    return { ok: false, error };
  }
}

/**
 * Runs every clock-driven schedule that is due. Safe to call from several processes: a schedule is
 * claimed by moving its `nextRunAt` forward in one conditional update, and only the winner runs it.
 */
export async function runDueSchedules(now = new Date()): Promise<number> {
  let ran = 0;
  for (;;) {
    const due = await ScheduleModel.findOne({ enabled: true, nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 });
    if (!due) return ran;

    const scheduledFor = due.nextRunAt!;
    const next = due.trigger.type === "once" ? null : computeNextRun(due.trigger, now);
    const claimed = await ScheduleModel.updateOne({ _id: due._id, nextRunAt: scheduledFor }, { $set: { nextRunAt: next } });
    if (claimed.modifiedCount === 0) continue; // another process took it

    if (now.getTime() - scheduledFor.getTime() > MISSED_RUN_GRACE_MS) {
      await ScheduleModel.updateOne({ _id: due._id }, { $set: { lastError: `Missed run of ${scheduledFor.toISOString()} (server was not running)` } });
      continue;
    }
    await executeSchedule(due);
    ran++;
  }
}

/** Called after a room changed status: fires the schedules waiting for that status. */
export async function fireStatusSchedules(roomId: string, status: string, now = new Date()): Promise<void> {
  const candidates = await ScheduleModel.find({
    enabled: true,
    "trigger.type": "status",
    "trigger.status": status,
    $or: [{ "trigger.roomId": { $exists: false } }, { "trigger.roomId": null }, { "trigger.roomId": roomId }],
  });
  for (const schedule of candidates) {
    if (schedule.lastRunAt && now.getTime() - schedule.lastRunAt.getTime() < STATUS_TRIGGER_COOLDOWN_MS) continue;
    await executeSchedule(schedule, { roomId });
  }
}
