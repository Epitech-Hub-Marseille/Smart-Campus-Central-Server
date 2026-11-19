import { ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { Schema, model } from "mongoose";
import { CHIME_LEVELS } from "../lib/chimes.js";

const targetsSchema = new Schema(
  {
    all: { type: Boolean, default: false },
    devices: { type: [String], default: [] },
    groups: { type: [String], default: [] },
    buildings: { type: [String], default: [] },
    floors: { type: [{ building: String, floor: Number, _id: false }], default: [] },
  },
  { _id: false },
);

/** What gets announced. A snapshot: editing a template later does not change existing schedules. */
const contentSchema = new Schema(
  {
    kind: { type: String, enum: ["text", "voice"], required: true },
    title: { type: String, trim: true, default: "" },
    text: { type: String, required: true, trim: true },
    priority: { type: String, enum: ANNOUNCE_PRIORITIES, default: "info" },
    voice: { type: String, default: "" },
    // Voice only: the chime played before the voice, by severity. Absent: none.
    chime: { type: String, enum: [...CHIME_LEVELS] },
    // A text announcement disappears this long after it is shown. Absent: it stays until cancelled.
    expiresAfterMinutes: { type: Number },
  },
  { _id: false },
);

/**
 * When it fires. `once` and the recurring kinds run on the clock; `status` runs when a room enters a
 * status (for example "closed"), optionally only for one room.
 */
const triggerSchema = new Schema(
  {
    type: { type: String, enum: ["once", "daily", "weekly", "status"], required: true },
    at: { type: Date },
    time: { type: String },
    days: { type: [Number], default: undefined },
    status: { type: String },
    roomId: { type: String },
  },
  { _id: false },
);

const scheduleSchema = new Schema(
  {
    scheduleId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    content: { type: contentSchema, required: true },
    trigger: { type: triggerSchema, required: true },
    // Absent for a status trigger: the announcement then goes to the screens of the room that changed.
    targets: { type: targetsSchema },
    enabled: { type: Boolean, default: true },
    // Next run on the clock. Null for status triggers and for a `once` that has run.
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date },
    lastError: { type: String },
    runCount: { type: Number, default: 0 },
    createdBy: { type: String },
    createdByName: { type: String, required: true },
  },
  { timestamps: true },
);

scheduleSchema.index({ enabled: 1, nextRunAt: 1 });
scheduleSchema.index({ "trigger.type": 1, "trigger.status": 1, enabled: 1 });

export const ScheduleModel = model("Schedule", scheduleSchema);
