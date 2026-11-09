import { ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { Schema, model } from "mongoose";

/**
 * An item of the Faculty news feed. Unlike an announcement it is not aimed at particular screens: it
 * goes to every Faculty screen, in the rotation.
 */
const newsSchema = new Schema(
  {
    newsId: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    // Short on purpose: it is read on a wall screen and has to fit in a protocol frame.
    text: { type: String, trim: true, default: "" },
    // "important" and "urgent" items are shown first.
    priority: { type: String, enum: ANNOUNCE_PRIORITIES, default: "info", required: true },
    publishedAt: { type: Date, default: () => new Date(), required: true },
    expiresAt: { type: Date },
    createdByName: { type: String, required: true },
  },
  { timestamps: true },
);

newsSchema.index({ publishedAt: -1 });

export const NewsModel = model("News", newsSchema);

export const newsDto = (n: InstanceType<typeof NewsModel>) => ({
  id: n.newsId,
  title: n.title,
  text: n.text,
  priority: n.priority,
  publishedAt: n.publishedAt,
  expiresAt: n.expiresAt ?? null,
  expired: Boolean(n.expiresAt && n.expiresAt.getTime() <= Date.now()),
  createdBy: n.createdByName,
});
