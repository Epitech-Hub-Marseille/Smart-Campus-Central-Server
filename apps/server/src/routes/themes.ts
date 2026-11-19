import { THEME_COLORS, THEME_FONTS, THEME_LIMITS, themeInput } from "@smartcampus/protocol";
import { Router } from "express";
import { requireAuth, requireRole, requireSession } from "../auth/middleware.js";
import { assignmentInput, createTheme, deleteTheme, resolveForDevice, setAssignment, themeDto, updateTheme } from "../domain/themes.js";
import { ThemeAssignmentModel, ThemeModel } from "../models/theme.js";

/** Visual themes for door units and Faculty screens. Admins and operators, from the console only. */
export const themesRouter = Router();
themesRouter.use(requireAuth, requireSession, requireRole("admin", "operator"));

/** What a theme can hold, so the console never keeps a copy that could drift. */
themesRouter.get("/schema", (_req, res) => {
  res.json({ colors: THEME_COLORS, fonts: THEME_FONTS, limits: THEME_LIMITS });
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
