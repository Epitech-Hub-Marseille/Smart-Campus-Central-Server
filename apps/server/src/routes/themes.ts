import { THEME_COLORS, THEME_FONT_SLOTS, THEME_FONTS, THEME_LIMITS, themeInput } from "@smartcampus/protocol";
import express, { Router } from "express";
import { requireAuth, requireRole, requireSession } from "../auth/middleware.js";
import { BUNDLE_LIMITS } from "../lib/themeBundle.js";
import { HttpError } from "../lib/errors.js";
import { assignmentInput, createTheme, importThemeBundle, deleteTheme, resolveForDevice, setAssignment, themeDto, updateTheme } from "../domain/themes.js";
import { ThemeAssignmentModel, ThemeModel } from "../models/theme.js";

/** Visual themes for door units and Faculty screens. Admins and operators, from the console only. */
export const themesRouter = Router();
themesRouter.use(requireAuth, requireSession, requireRole("admin", "operator"));

/** What a theme can hold, so the console never keeps a copy that could drift. */
themesRouter.get("/schema", (_req, res) => {
  res.json({ colors: THEME_COLORS, fonts: THEME_FONTS, fontSlots: THEME_FONT_SLOTS, limits: THEME_LIMITS });
});

themesRouter.get("/", async (_req, res) => {
  res.json({ items: (await ThemeModel.find().sort({ name: 1 }).limit(200)).map(themeDto) });
});

themesRouter.get("/assignments", async (_req, res) => {
  const [assignments, themes] = await Promise.all([ThemeAssignmentModel.find().sort({ scope: 1, key: 1 }), ThemeModel.find()]);
  const names = new Map(themes.map((t) => [t.themeId, t.name]));
  res.json({ items: assignments.map((a) => ({ scope: a.scope, key: a.key, themeId: a.themeId, themeName: names.get(a.themeId) ?? "(deleted)" })) });
});

themesRouter.put("/assignments", async (req, res) => {
  await setAssignment(assignmentInput.parse(req.body), req.user!);
  res.status(204).end();
});

/** What a device wears and why, for the console. */
themesRouter.get("/resolve/:deviceId", async (req, res) => {
  res.json(await resolveForDevice(String(req.params.deviceId)));
});

/** A theme and its fonts in one .zip (raw body). `?replace=1` makes a theme of the same name a new version of itself. */
themesRouter.post("/import", express.raw({ type: () => true, limit: BUNDLE_LIMITS.zipBytes }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the .zip file as the request body");
  const result = await importThemeBundle(req.body, req.user!, req.query.replace === "1");
  res.status(result.created ? 201 : 200).json({ theme: themeDto(result.theme), created: result.created, fonts: result.fonts });
});

themesRouter.post("/", async (req, res) => {
  res.status(201).json(themeDto(await createTheme(themeInput.parse(req.body), req.user!)));
});

themesRouter.put("/:id", async (req, res) => {
  res.json(themeDto(await updateTheme(String(req.params.id), themeInput.parse(req.body), req.user!)));
});

themesRouter.delete("/:id", async (req, res) => {
  await deleteTheme(String(req.params.id), req.user!);
  res.status(204).end();
});
