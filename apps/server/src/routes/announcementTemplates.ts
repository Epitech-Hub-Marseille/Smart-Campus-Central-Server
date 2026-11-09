import { ANNOUNCE_PRIORITIES, ulid } from "@smartcampus/protocol";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import { MAX_SPEECH_CHARS } from "../domain/intercom.js";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { AnnouncementTemplateModel, templateDto } from "../models/announcementTemplate.js";

/** Library of reusable announcement texts. Admins and operators only: it is a management tool. */
export const announcementTemplatesRouter = Router();
announcementTemplatesRouter.use(requireRole("admin", "operator"));

const templateInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["text", "voice"]).default("text"),
  title: z.string().trim().max(200).default(""),
  // A voice template is limited to what the engine accepts, so a saved template can always be used.
  text: z.string().trim().min(1).max(2000),
  priority: z.enum(ANNOUNCE_PRIORITIES).default("info"),
  voice: z.string().trim().max(60).default(""),
});

const checked = (input: z.infer<typeof templateInput>) => {
  if (input.kind === "voice" && input.text.length > MAX_SPEECH_CHARS) {
    throw new HttpError(400, `text: a voice template holds at most ${MAX_SPEECH_CHARS} characters`);
  }
  return input;
};

announcementTemplatesRouter.get("/", async (_req, res) => {
  const items = await AnnouncementTemplateModel.find().sort({ name: 1 }).collation({ locale: "en", strength: 2 }).limit(500);
  res.json({ items: items.map(templateDto) });
});

announcementTemplatesRouter.post("/", async (req, res) => {
  const input = checked(templateInput.parse(req.body));
  const template = await AnnouncementTemplateModel.create({ ...input, templateId: ulid(), createdByName: req.user!.name });
  await recordAudit(req.user!, "template.create", { type: "template", id: template.templateId }, { name: template.name });
  res.status(201).json(templateDto(template));
});

announcementTemplatesRouter.put("/:id", async (req, res) => {
  const input = checked(templateInput.parse(req.body));
  const template = await AnnouncementTemplateModel.findOneAndUpdate({ templateId: String(req.params.id) }, { $set: input }, { new: true });
  if (!template) throw new HttpError(404, "Template not found");
  await recordAudit(req.user!, "template.update", { type: "template", id: template.templateId }, { name: template.name });
  res.json(templateDto(template));
});

announcementTemplatesRouter.delete("/:id", async (req, res) => {
  const template = await AnnouncementTemplateModel.findOneAndDelete({ templateId: String(req.params.id) });
  if (!template) throw new HttpError(404, "Template not found");
  await recordAudit(req.user!, "template.delete", { type: "template", id: template.templateId }, { name: template.name });
  res.status(204).end();
});
