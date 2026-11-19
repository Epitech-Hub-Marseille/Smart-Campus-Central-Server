import { CONTENT_FIT, CONTENT_KINDS } from "@smartcampus/protocol";
import { Schema, model } from "mongoose";

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

/**
 * One slide of the custom content of the Faculty screens: an uploaded image or video, a text, or a live web
 * page. Which screens show it is decided by `targets`, the same way as for announcements, and when by
 * `startsAt` and `endsAt`.
 */
const contentSchema = new Schema(
  {
    // ULID. Also the `id` of the slide in `content.set`.
    contentId: { type: String, required: true, unique: true },
    kind: { type: String, enum: CONTENT_KINDS, required: true },
    title: { type: String, trim: true, default: "" },
    text: { type: String, trim: true },
    url: { type: String, trim: true },
    refreshSeconds: { type: Number },
    // Library file, for an image or a video.
    assetId: { type: String },
    durationSeconds: { type: Number, default: 15, required: true },
    fit: { type: String, enum: CONTENT_FIT, default: "contain", required: true },
    startsAt: { type: Date },
    endsAt: { type: Date },
    targets: { type: targetsSchema, required: true },
    // A paused slide stays in the library but is not sent.
    enabled: { type: Boolean, default: true },
    createdByName: { type: String, required: true },
  },
  { timestamps: true },
);

contentSchema.index({ createdAt: 1 });
contentSchema.index({ assetId: 1 }, { sparse: true });

export const ContentModel = model("Content", contentSchema);
