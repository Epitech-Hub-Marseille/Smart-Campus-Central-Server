import { Router } from "express";
import { requireRole } from "../auth/middleware.js";
import { contentInput, createContent, deleteContent, displaysReachedBy, updateContent } from "../domain/content.js";
import { HttpError } from "../lib/errors.js";
import { ContentModel } from "../models/content.js";

/** The custom content of the Faculty screens. Admins and operators only: it decides what hangs on the walls. */
export const contentRouter = Router();
contentRouter.use(requireRole("admin", "operator"));

const dto = async (c: InstanceType<typeof ContentModel>) => ({
  id: c.contentId,
  kind: c.kind,
  title: c.title,
  text: c.text ?? null,
  url: c.url ?? null,
  refreshSeconds: c.refreshSeconds ?? null,
  assetId: c.assetId ?? null,
  durationSeconds: c.durationSeconds,
  fit: c.fit,
  startsAt: c.startsAt ?? null,
  endsAt: c.endsAt ?? null,
  targets: c.targets,
  enabled: c.enabled,
  // "Over" is derived so the console never has to compare clocks.
  state: !c.enabled ? "paused" : c.endsAt && c.endsAt.getTime() <= Date.now() ? "over" : c.startsAt && c.startsAt.getTime() > Date.now() ? "scheduled" : "live",
  displayCount: await displaysReachedBy(c.targets as never),
  createdBy: c.createdByName,
  createdAt: c.createdAt,
});

contentRouter.get("/", async (_req, res) => {
  const items = await ContentModel.find().sort({ createdAt: 1 }).limit(200);
  res.json({ items: await Promise.all(items.map(dto)) });
});

contentRouter.post("/", async (req, res) => {
  res.status(201).json(await dto(await createContent(contentInput.parse(req.body), req.user!)));
});

contentRouter.put("/:id", async (req, res) => {
  res.json(await dto(await updateContent(String(req.params.id), contentInput.parse(req.body), req.user!)));
});

contentRouter.delete("/:id", async (req, res) => {
  await deleteContent(String(req.params.id), req.user!);
  res.status(204).end();
});

contentRouter.get("/:id", async (req, res) => {
  const content = await ContentModel.findOne({ contentId: String(req.params.id) });
  if (!content) throw new HttpError(404, "Content not found");
  res.json(await dto(content));
});
