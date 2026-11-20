import { SERVICES, ulid } from "@smartcampus/protocol";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { integrationDto, placesOf, setPlace, splitConfig, syncIntegration } from "../domain/integrations.js";
import { getPlugin, listPlugins, PLUGIN_IDS } from "../integrations/registry.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { objectId, pagination } from "../lib/http.js";
import { CampusEventModel, campusEventDto } from "../models/campusEvent.js";
import { BuildingModel } from "../models/building.js";
import { IntegrationModel } from "../models/integration.js";
import { ReservationModel } from "../models/reservation.js";

/**
 * Portals (ENT, student portals, campus administration systems) the campus reads events from. The settings can hold a link that
 * is a key to someone's calendar, so changing them is for administrators; operators may look at what was read. Nothing here is
 * open to API keys.
 */
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

const admin = requireRole("admin");
const reader = requireRole("admin", "operator");

/** The plugins installed, and the settings each one takes, so the console can draw the form without knowing them. */
integrationsRouter.get("/plugins", reader, (_req, res) => {
  res.json({ items: listPlugins().map(({ id, label, description, fields }) => ({ id, label, description, fields })) });
});

const common = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
  horizonDays: z.number().int().min(1).max(90),
  autoRegister: z.boolean(),
  registerService: z.enum(SERVICES).nullable(),
  // "Pédagogie 1-8" -> "B2-104": what a room is called in the portal when it is not its name or code here.
  ignoredPlaces: z.array(z.string().trim().min(1).max(120)).max(200),
  autoCreateRooms: z.boolean(),
  autoCreateBuildingId: z.string().min(1).max(40).nullable(),
  autoCreateFloor: z.number().int().min(-10).max(200),
  roomAliases: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(60)).refine((r) => Object.keys(r).length <= 200, "Too many aliases"),
};
const createInput = z.object({ plugin: z.enum(PLUGIN_IDS), config: z.record(z.string(), z.unknown()).default({}) }).extend({ ...common }).partial({ enabled: true, intervalMinutes: true, horizonDays: true, autoRegister: true, registerService: true, roomAliases: true, ignoredPlaces: true, autoCreateRooms: true, autoCreateBuildingId: true, autoCreateFloor: true });
const updateInput = z.object({ config: z.record(z.string(), z.unknown()) }).extend({ ...common }).partial();

integrationsRouter.get("/", reader, async (_req, res) => {
  const items = await IntegrationModel.find().sort({ name: 1 });
  res.json({ items: items.map(integrationDto) });
});

integrationsRouter.post("/", admin, async (req, res) => {
  const input = createInput.parse(req.body);
  const plugin = getPlugin(input.plugin)!;
  const { plain, secrets } = splitConfig(plugin, input.config);
  const doc = await IntegrationModel.create({
    integrationId: ulid(),
    plugin: input.plugin,
    name: input.name,
    enabled: input.enabled ?? true,
    config: plain,
    secrets,
    ...(input.intervalMinutes && { intervalMinutes: input.intervalMinutes }),
    ...(input.horizonDays && { horizonDays: input.horizonDays }),
    ...(input.autoRegister !== undefined && { autoRegister: input.autoRegister }),
    ...(input.registerService && { registerService: input.registerService }),
    ...(input.roomAliases && { roomAliases: input.roomAliases }),
    ...(input.ignoredPlaces && { ignoredPlaces: input.ignoredPlaces }),
    ...(input.autoCreateRooms !== undefined && { autoCreateRooms: input.autoCreateRooms }),
    ...(input.autoCreateFloor !== undefined && { autoCreateFloor: input.autoCreateFloor }),
    ...(input.autoCreateBuildingId && { autoCreateBuilding: await existingBuilding(input.autoCreateBuildingId) }),
  });
  await recordAudit(req.user!, "integration.create", { type: "integration", id: doc.integrationId }, { plugin: doc.plugin, name: doc.name });
  res.status(201).json(integrationDto(doc));
});

async function existingBuilding(id: string) {
  if (!(await BuildingModel.exists({ _id: objectId(id) }))) throw new HttpError(404, "Building not found");
  return id;
}

async function find(id: string) {
  const doc = await IntegrationModel.findOne({ integrationId: id });
  if (!doc) throw new HttpError(404, "Integration not found");
  return doc;
}

integrationsRouter.patch("/:id", admin, async (req, res) => {
  const doc = await find(String(req.params.id));
  const input = updateInput.parse(req.body);
  const plugin = getPlugin(doc.plugin);
  if (input.config) {
    if (!plugin) throw new HttpError(409, "The plugin of this integration is not installed");
    const { plain, secrets } = splitConfig(plugin, input.config, doc);
    doc.set({ config: plain, secrets });
  }
  const { config: _config, registerService, autoCreateBuildingId, ...rest } = input;
  doc.set(rest);
  if (registerService !== undefined) doc.set("registerService", registerService ?? undefined);
  if (autoCreateBuildingId !== undefined) doc.set("autoCreateBuilding", autoCreateBuildingId === null ? undefined : await existingBuilding(autoCreateBuildingId));
  if (input.roomAliases) doc.markModified("roomAliases");
  // New rooms are created in a building: asking for them with none chosen would silently do nothing.
  if (doc.autoCreateRooms && !doc.autoCreateBuilding) throw new HttpError(400, "Choose the building new rooms go in");
  // A change of settings is read soon, not at the next turn of the timer.
  doc.set("nextSyncAt", new Date());
  await doc.save();
  await recordAudit(req.user!, "integration.update", { type: "integration", id: doc.integrationId }, { fields: Object.keys(input) });
  res.json(integrationDto(doc));
});

/** Removes the integration and what it brought: its events and the reservations that mirrored them. Accounts it registered stay. */
integrationsRouter.delete("/:id", admin, async (req, res) => {
  const doc = await find(String(req.params.id));
  await ReservationModel.updateMany({ source: `integration:${doc.integrationId}`, status: "active" }, { status: "cancelled", cancelledByName: doc.name });
  const events = await CampusEventModel.deleteMany({ integration: doc._id });
  await doc.deleteOne();
  await recordAudit(req.user!, "integration.delete", { type: "integration", id: doc.integrationId }, { name: doc.name, events: events.deletedCount });
  res.status(204).end();
});

/** Reads the portal now. */
integrationsRouter.post("/:id/sync", admin, async (req, res) => {
  const doc = await find(String(req.params.id));
  res.json({ summary: await syncIntegration(doc.integrationId, req.user!), integration: integrationDto(await find(doc.integrationId)) });
});

/** Every place the events name and what each one is here: a room, ignored, or nothing yet. */
integrationsRouter.get("/:id/places", reader, async (req, res) => {
  res.json({ items: await placesOf(await find(String(req.params.id))) });
});

const placeInput = z
  .object({ place: z.string().trim().min(1).max(120) })
  .and(z.discriminatedUnion("action", [z.object({ action: z.literal("room"), roomId: z.string().min(1).max(40) }), z.object({ action: z.literal("create") }), z.object({ action: z.literal("ignore") }), z.object({ action: z.literal("clear") })]));

/** Settles one place: it is this room, it gets a room of its own, it is not a room, or the choice is taken back. Rooms are campus data, so operators may. */
integrationsRouter.put("/:id/places", reader, async (req, res) => {
  const { place, ...choice } = placeInput.parse(req.body);
  const doc = await find(String(req.params.id));
  res.json({ items: await setPlace(doc, place, choice.action === "room" ? { action: "room", roomId: objectId(choice.roomId) } : (choice as never), req.user!) });
});

const eventsQuery = pagination.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.enum(["active", "cancelled"]).optional(), integration: z.string().max(40).optional() });

integrationsRouter.get("/events", reader, async (req, res) => {
  const q = eventsQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.from) filter.end = { $gt: q.from };
  if (q.to) filter.start = { $lt: q.to };
  if (q.integration) {
    const doc = await IntegrationModel.findOne({ integrationId: q.integration }, { _id: 1 });
    filter.integration = doc?._id ?? null;
  }
  const [items, total] = await Promise.all([
    CampusEventModel.find(filter).sort({ start: 1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    CampusEventModel.countDocuments(filter),
  ]);
  res.json({ items: items.map(campusEventDto), total, page: q.page, limit: q.limit });
});
