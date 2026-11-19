import { ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { Schema, model } from "mongoose";

/**
 * A reusable announcement ("The building is closing in 10 minutes"). A template is content only: who
 * receives it and when is decided each time it is used.
 */
const templateSchema = new Schema(
  {
    templateId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    // text: shown on screens. voice: read out loud by the text-to-speech engine.
    kind: { type: String, enum: ["text", "voice"], default: "text", required: true },
    title: { type: String, trim: true, default: "" },
    text: { type: String, required: true, trim: true },
    priority: { type: String, enum: ANNOUNCE_PRIORITIES, default: "info", required: true },
    // Voice id, only for kind "voice". Empty means the engine's first voice.
    voice: { type: String, trim: true, default: "" },
    createdByName: { type: String, required: true },
  },
  { timestamps: true },
);

templateSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const AnnouncementTemplateModel = model("AnnouncementTemplate", templateSchema);

export const templateDto = (t: InstanceType<typeof AnnouncementTemplateModel>) => ({
  id: t.templateId,
  name: t.name,
  kind: t.kind,
  title: t.title,
  text: t.text,
  priority: t.priority,
  voice: t.voice,
  createdBy: t.createdByName,
  updatedAt: t.updatedAt,
});
