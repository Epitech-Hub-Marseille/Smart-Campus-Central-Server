import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFacultyContent } from "../faculty.js";
import { MAX_REGISTERED_PER_EVENT, refreshEventAvailability, runDueIntegrations, syncIntegration } from "../integrations.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { BuildingModel } from "../../models/building.js";
import { CampusEventModel } from "../../models/campusEvent.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { IntegrationModel } from "../../models/integration.js";
import { ReservationModel } from "../../models/reservation.js";
import { RoomModel } from "../../models/room.js";
import { UserModel } from "../../models/user.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let admin: ApiClient;
let operator: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [admin, operator, staff] = await Promise.all([h.login("admin"), h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

const FEED = "https://my.epitech.eu/api/events/calendar/00000000-0000-4000-8000-000000000000?campus=MAR";
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

interface FeedEvent {
  uid: string;
  title?: string;
  from?: number;
  to?: number;
  location?: string;
  people?: string[];
}
/** A calendar as the portal serves it: starts and ends are minutes from now. */
const calendar = (events: FeedEvent[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events
    .map(
      (e) =>
        `BEGIN:VEVENT\r\nUID:${e.uid}\r\nSUMMARY:${e.title ?? "[G-CPE-110] Bootstrap"}\r\nDTSTART:${stamp(minutes(e.from ?? -30))}\r\nDTEND:${stamp(minutes(e.to ?? 60))}\r\nLOCATION:${e.location ?? ""}\r\n${(e.people ?? []).join("\r\n")}${e.people ? "\r\n" : ""}END:VEVENT\r\n`,
    )
    .join("")}END:VCALENDAR\r\n`;
const portal = (body: string | (() => Response)) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: URL | string) => {
    calls.push(String(url));
    return typeof body === "string" ? new Response(body, { status: 200 }) : body();
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
};
const attendee = (name: string, email: string) => `ATTENDEE;CN=${name}:mailto:${email}`;

let roomId: string;
let integrationId: string;
const sync = (feed: string | (() => Response)) => syncIntegration(integrationId, null, { fetch: portal(feed).fetch });

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), RoomModel.deleteMany({}), BuildingModel.deleteMany({}), ReservationModel.deleteMany({}), AuditLogModel.deleteMany({}), CampusEventModel.deleteMany({}), IntegrationModel.deleteMany({})]);
  await UserModel.deleteMany({ email: { $not: /@test\.local$/ } });
  await UserModel.updateMany({}, { $unset: { service: 1, availability: 1 } });
  const building = await BuildingModel.create({ code: "B1", name: "Building 1" });
  roomId = String((await RoomModel.create({ building: building._id, code: "B1-08", name: "Pédagogie 1-8", floor: 1 }))._id);
  const created = await admin.request("POST", "/integrations", { plugin: "epitech-my", name: "Epitech MY", config: { feedUrl: FEED }, registerService: "pedagogical" });
  expect(created.status).toBe(201);
  integrationId = created.body.id;
});

describe("setting up an integration", () => {
  it("lists the plugins and their settings, for administrators and operators only", async () => {
    const res = await operator.request("GET", "/integrations/plugins");
    expect(res.body.items).toEqual([expect.objectContaining({ id: "epitech-my", fields: [expect.objectContaining({ key: "feedUrl", secret: true })] })]);
    expect((await staff.request("GET", "/integrations/plugins")).status).toBe(403);
    expect((await h.anonymous.request("GET", "/integrations")).status).toBe(401);
  });

  it("keeps the link encrypted and never returns it", async () => {
    const listed = await admin.request("GET", "/integrations");
    expect(JSON.stringify(listed.body)).not.toContain("00000000-0000");
    expect(listed.body.items[0]).toMatchObject({ plugin: "epitech-my", enabled: true, secretsSet: ["feedUrl"], config: {}, intervalMinutes: 15, horizonDays: 14, autoRegister: true, lastStatus: "never" });
    const stored = await IntegrationModel.findOne({ integrationId }).lean();
    expect(JSON.stringify(stored)).not.toContain("00000000-0000");
    expect((stored!.secrets as Record<string, string>).feedUrl).toMatch(/^v1\./);
  });

  it("refuses a link that is not the portal's, other people, and a plugin that does not exist", async () => {
    const make = (body: object, client = admin) => client.request("POST", "/integrations", { name: "x", ...body });
    expect((await make({ plugin: "epitech-my", config: { feedUrl: "https://evil.example/cal" } })).status).toBe(400);
    expect((await make({ plugin: "epitech-my", config: { feedUrl: "http://my.epitech.eu/cal" } })).status).toBe(400);
    expect((await make({ plugin: "epitech-my", config: {} })).status).toBe(400);
    expect((await make({ plugin: "nope", config: {} })).status).toBe(400);
    expect((await make({ plugin: "epitech-my", config: { feedUrl: FEED } }, operator)).status).toBe(403);
    expect((await operator.request("PATCH", `/integrations/${integrationId}`, { name: "y" })).status).toBe(403);
    expect((await operator.request("POST", `/integrations/${integrationId}/sync`)).status).toBe(403);
  });

  it("keeps the link when it is left out of a change, and replaces it when it is sent", async () => {
    await admin.request("PATCH", `/integrations/${integrationId}`, { name: "Renamed", intervalMinutes: 30 });
    const doc = await IntegrationModel.findOne({ integrationId });
    expect(doc).toMatchObject({ name: "Renamed", intervalMinutes: 30 });
    const fetchSpy = portal(calendar([]));
    await syncIntegration(integrationId, null, { fetch: fetchSpy.fetch });
    expect(fetchSpy.calls[0]).toBe(FEED);
    const other = "https://my.epitech.eu/api/events/calendar/11111111-1111-4111-8111-111111111111?campus=MAR";
    expect((await admin.request("PATCH", `/integrations/${integrationId}`, { config: { feedUrl: other } })).status).toBe(200);
    const again = portal(calendar([]));
    await syncIntegration(integrationId, null, { fetch: again.fetch });
    expect(again.calls[0]).toBe(other);
  });
});

describe("reading a portal", () => {
  it("stores the events, reserves the rooms they name and says which places it could not match", async () => {
    const summary = await sync(calendar([{ uid: "1", location: "Pédagogie 1-8" }, { uid: "2", title: "Remote", location: "En distanciel (Teams)" }, { uid: "5", title: "Elsewhere", location: "Salle Inconnue" }, { uid: "3", from: 24 * 60 * 30, to: 24 * 60 * 30 + 60 }]));
    expect(summary).toMatchObject({ fetched: 3, created: 3, updated: 0, cancelled: 0, reservations: 1, unmatchedLocations: ["Salle Inconnue"] });
    const reservations = await ReservationModel.find({});
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ title: "[G-CPE-110] Bootstrap", organizerName: "Epitech MY", source: expect.stringMatching(/^integration:/), status: "active" });
    expect(String(reservations[0]!.room)).toBe(roomId);
    const status = (await admin.request("GET", "/integrations")).body.items[0];
    expect(status).toMatchObject({ lastStatus: "ok", lastSummary: { created: 3 } });
    expect(await AuditLogModel.countDocuments({ action: "integration.sync" })).toBe(1);
  });

  it("matches a place by an alias set on the integration", async () => {
    await admin.request("PATCH", `/integrations/${integrationId}`, { roomAliases: { "Salle de classe 8": "B1-08" } });
    const summary = await sync(calendar([{ uid: "1", location: "salle de classe 8" }]));
    expect(summary).toMatchObject({ reservations: 1, unmatchedLocations: [] });
  });

  it("is quiet when nothing changed, and follows a change of time or room", async () => {
    await sync(calendar([{ uid: "1", location: "Pédagogie 1-8" }]));
    expect(await sync(calendar([{ uid: "1", location: "Pédagogie 1-8" }]))).toMatchObject({ created: 0, updated: 0, cancelled: 0 });
    const moved = await sync(calendar([{ uid: "1", location: "Pédagogie 1-8", to: 120 }]));
    expect(moved).toMatchObject({ created: 0, updated: 1 });
    expect((await ReservationModel.findOne({}))!.end.getTime()).toBeGreaterThan(minutes(100).getTime());
    expect(await ReservationModel.countDocuments()).toBe(1);
    await sync(calendar([{ uid: "1", location: "Somewhere else" }]));
    expect(await ReservationModel.countDocuments({ status: "active" })).toBe(0);
  });

  it("cancels what the portal stops listing, and the reservation with it", async () => {
    await sync(calendar([{ uid: "1", location: "Pédagogie 1-8" }, { uid: "2", location: "Pédagogie 1-8", from: 90, to: 150 }]));
    const summary = await sync(calendar([{ uid: "2", location: "Pédagogie 1-8", from: 90, to: 150 }]));
    expect(summary.cancelled).toBe(1);
    expect(await CampusEventModel.countDocuments({ status: "cancelled" })).toBe(1);
    expect(await ReservationModel.countDocuments({ status: "active" })).toBe(1);
  });

  it("keeps what it has and says so when the portal fails, and does not repeat the link", async () => {
    await sync(calendar([{ uid: "1", location: "Pédagogie 1-8" }]));
    const failing = await syncIntegration(integrationId, null, { fetch: portal(() => new Response("", { status: 500 })).fetch }).catch((e: unknown) => e);
    expect(failing).toMatchObject({ status: 502, message: expect.stringMatching(/answered 500/) });
    const doc = (await admin.request("GET", "/integrations")).body.items[0];
    expect(doc).toMatchObject({ lastStatus: "error", lastError: expect.stringMatching(/answered 500/) });
    expect(JSON.stringify(doc)).not.toContain("00000000-0000");
    expect(await CampusEventModel.countDocuments({ status: "active" })).toBe(1);
    expect(await ReservationModel.countDocuments({ status: "active" })).toBe(1);
  });

  it("reads only integrations that are due, and a disabled one never", async () => {
    const ok = portal(calendar([]));
    expect(await runDueIntegrations(new Date(), { fetch: ok.fetch })).toBe(1);
    expect(await runDueIntegrations(new Date(), { fetch: ok.fetch })).toBe(0);
    expect(await runDueIntegrations(new Date(Date.now() + 16 * 60_000), { fetch: ok.fetch })).toBe(1);
    await IntegrationModel.updateOne({ integrationId }, { enabled: false, nextSyncAt: new Date(0) });
    expect(await runDueIntegrations(new Date(), { fetch: ok.fetch })).toBe(0);
  });

  it("will not run two reads of one integration at once", async () => {
    await IntegrationModel.updateOne({ integrationId }, { lockedUntil: new Date(Date.now() + 60_000) });
    await expect(sync(calendar([]))).rejects.toMatchObject({ status: 409 });
  });

  it("removes the events and the reservations when the integration is deleted, and keeps the accounts it registered", async () => {
    await sync(calendar([{ uid: "1", location: "Pédagogie 1-8", people: [attendee("Jane Doe", "jane.doe@campus.test")] }]));
    expect((await admin.request("DELETE", `/integrations/${integrationId}`)).status).toBe(204);
    expect(await CampusEventModel.countDocuments()).toBe(0);
    expect(await ReservationModel.countDocuments({ status: "active" })).toBe(0);
    expect(await UserModel.countDocuments({ email: "jane.doe@campus.test" })).toBe(1);
  });
});

describe("the people of an event", () => {
  it("puts the event under the name of a member of staff who already exists", async () => {
    const jane = await UserModel.create({ name: "Jane Doe", email: "jane.doe@campus.test", service: "pedagogical" });
    const summary = await sync(calendar([{ uid: "1", location: "Pédagogie 1-8", people: [attendee("J. Doe", "Jane.Doe@campus.test")] }]));
    expect(summary).toMatchObject({ linkedPeople: 1, registeredPeople: 0 });
    expect((await ReservationModel.findOne({}))).toMatchObject({ organizerName: "Jane Doe", organizerId: String(jane._id) });
    expect((await CampusEventModel.findOne({}))!.people[0]).toMatchObject({ userId: jane._id });
  });

  it("links by an exact name when there is no email, but only when one account has it", async () => {
    await UserModel.create({ name: "Sam Roe", email: "sam@campus.test" });
    await UserModel.create({ name: "Lee Twin", email: "lee1@campus.test" });
    await UserModel.create({ name: "Lee Twin", email: "lee2@campus.test" });
    await sync(calendar([{ uid: "1", people: ["ORGANIZER;CN=sam roe:nobody", "ATTENDEE;CN=Lee Twin:nobody"] }]));
    const [event] = await CampusEventModel.find({});
    expect(event!.people.map((p) => [p.name, Boolean(p.userId)])).toEqual([["sam roe", true], ["Lee Twin", false]]);
    // With no email there is nothing to register an account from either.
    expect(await UserModel.countDocuments({ name: "Lee Twin" })).toBe(2);
  });

  it("registers an unknown invitee who has an email: no way to sign in, listed under the integration's service", async () => {
    const summary = await sync(calendar([{ uid: "1", location: "Pédagogie 1-8", people: [attendee("New Teacher", "new.teacher@campus.test")] }]));
    expect(summary.registeredPeople).toBe(1);
    const user = await UserModel.findOne({ email: "new.teacher@campus.test" });
    expect(user).toMatchObject({ name: "New Teacher", service: "pedagogical", groups: [], source: expect.stringMatching(/^integration:/) });
    expect(user!.passwordHash).toBeUndefined();
    expect((await ReservationModel.findOne({}))!.organizerName).toBe("New Teacher");
  });

  it("does not register anyone when the integration says not to, or from an event that names a whole class", async () => {
    await admin.request("PATCH", `/integrations/${integrationId}`, { autoRegister: false });
    await sync(calendar([{ uid: "1", people: [attendee("No One", "no.one@campus.test")] }]));
    expect(await UserModel.countDocuments({ email: "no.one@campus.test" })).toBe(0);
    await admin.request("PATCH", `/integrations/${integrationId}`, { autoRegister: true });
    const crowd = Array.from({ length: MAX_REGISTERED_PER_EVENT + 1 }, (_v, i) => attendee(`Student ${i}`, `student${i}@campus.test`));
    await sync(calendar([{ uid: "2", people: crowd }]));
    expect(await UserModel.countDocuments({ email: /^student\d+@campus\.test$/ })).toBe(0);
  });
});

describe("busy during an event", () => {
  const staffInEvent = async () => {
    const jane = await UserModel.create({ name: "Jane Doe", email: "jane.doe@campus.test", service: "pedagogical" });
    await sync(calendar([{ uid: "1", title: "[G-CPE-110] Defense", people: [attendee("Jane Doe", "jane.doe@campus.test")] }]));
    return jane;
  };
  const janeOnScreen = async () => (await buildFacultyContent("all")).staff.find((s) => s.name === "Jane Doe")!;

  it("shows a person in an event as busy, with its title, until it ends", async () => {
    await staffInEvent();
    expect(await janeOnScreen()).toMatchObject({ availability: "busy", note: "[G-CPE-110] Defense" });
    expect((await janeOnScreen()).until).toBeGreaterThan(Date.now());
    const list = (await operator.request("GET", "/faculty/staff")).body.items.find((s: { name: string }) => s.name === "Jane Doe");
    expect(list).toMatchObject({ availability: "busy", note: "[G-CPE-110] Defense" });
  });

  it("is available again outside the event", async () => {
    await UserModel.create({ name: "Jane Doe", email: "jane.doe@campus.test", service: "pedagogical" });
    await sync(calendar([{ uid: "1", from: 120, to: 180, people: [attendee("Jane Doe", "jane.doe@campus.test")] }]));
    expect(await janeOnScreen()).toMatchObject({ availability: "available" });
  });

  it("lets what the person or an administrator says win over the event", async () => {
    const jane = await staffInEvent();
    await admin.request("PUT", `/faculty/availability/${jane._id}`, { status: "away", note: "Lunch" });
    expect(await janeOnScreen()).toMatchObject({ availability: "away", note: "Lunch" });
    // Saying "available" while in the event frees them until it ends, then the next event counts again.
    await admin.request("PUT", `/faculty/availability/${jane._id}`, { status: "available" });
    expect(await janeOnScreen()).toMatchObject({ availability: "available" });
    const stored = await UserModel.findById(jane._id);
    expect(stored!.availability!.until!.getTime()).toBeGreaterThan(Date.now());
    expect((await buildFacultyContent("all", new Date(Date.now() + 2 * 3_600_000))).staff.find((s) => s.name === "Jane Doe")).toMatchObject({ availability: "available" });
    await sync(calendar([{ uid: "1", title: "[G-CPE-110] Defense", from: -30, to: 60, people: [attendee("Jane Doe", "jane.doe@campus.test")] }, { uid: "2", title: "Next", from: 90, to: 150, people: [attendee("Jane Doe", "jane.doe@campus.test")] }]));
    expect((await buildFacultyContent("all", minutes(100))).staff.find((s) => s.name === "Jane Doe")).toMatchObject({ availability: "busy", note: "Next" });
  });

  it("tells the screens when someone starts or finishes an event, and only then", async () => {
    await staffInEvent();
    await refreshEventAvailability();
    await CommandModel.deleteMany({});
    expect(await refreshEventAvailability()).toBe(false);
    await CampusEventModel.updateMany({}, { end: new Date(Date.now() - 1000) });
    expect(await refreshEventAvailability()).toBe(true);
    expect(await refreshEventAvailability()).toBe(false);
  });
});

describe("places: which room is a place of the portal", () => {
  const places = async () => (await operator.request("GET", `/integrations/${integrationId}/places`)).body.items as { place: string; events: number; state: string; roomId: string | null; via: string | null }[];
  const setPlace = (body: object, client = operator) => client.request("PUT", `/integrations/${integrationId}/places`, body);
  const feed = () => calendar([{ uid: "1", location: "Pédagogie 1-8" }, { uid: "2", from: 90, to: 150, location: "Salle X" }, { uid: "3", from: 200, to: 260, location: "Salle X" }, { uid: "4", from: 300, to: 360, location: "En distanciel (Teams)" }]);

  it("lists what each place is: a room, not one yet (first), or not a room at all", async () => {
    await sync(feed());
    expect(await places()).toEqual([
      { place: "Salle X", events: 2, state: "none", roomId: null, via: null },
      { place: "Pédagogie 1-8", events: 1, state: "room", roomId, via: "name" },
      { place: "En distanciel (Teams)", events: 1, state: "ignored", roomId: null, via: null },
    ]);
    expect((await staff.request("GET", `/integrations/${integrationId}/places`)).status).toBe(403);
  });

  it("assigns a place to a room at once, without reading the portal again", async () => {
    await sync(feed());
    const other = String((await RoomModel.create({ building: (await BuildingModel.findOne({}))!._id, code: "B1-09", floor: 1 }))._id);
    const res = await setPlace({ place: "Salle X", action: "room", roomId: other });
    expect(res.status).toBe(200);
    expect(res.body.items.find((p: { place: string }) => p.place === "Salle X")).toMatchObject({ state: "room", roomId: other, via: "alias" });
    expect(await ReservationModel.countDocuments({ room: other, status: "active" })).toBe(2);
    expect((await IntegrationModel.findOne({ integrationId }))!.roomAliases).toMatchObject({ "Salle X": other });
    // And it stays so at the next reading.
    expect(await sync(feed())).toMatchObject({ unmatchedLocations: [], updated: 0 });
    // Taking the choice back frees the reservations again.
    await setPlace({ place: "Salle X", action: "clear" });
    expect(await ReservationModel.countDocuments({ room: other, status: "active" })).toBe(0);
  });

  it("refuses a room that does not exist, and an id that is not one", async () => {
    await sync(feed());
    expect((await setPlace({ place: "Salle X", action: "room", roomId: "507f1f77bcf86cd799439011" })).status).toBe(404);
    expect((await setPlace({ place: "Salle X", action: "room", roomId: "nope" })).status).toBe(404);
    expect((await setPlace({ place: "Salle X", action: "fly" })).status).toBe(400);
  });

  it("makes a room for a place in the building chosen, with a first guess at its kind", async () => {
    await sync(feed());
    expect((await setPlace({ place: "Salle X", action: "create" })).status).toBe(409);
    const building = (await BuildingModel.findOne({}))!;
    await admin.request("PATCH", `/integrations/${integrationId}`, { autoCreateBuildingId: String(building._id), autoCreateFloor: 2 });
    const res = await setPlace({ place: "Salle X", action: "create" });
    expect(res.status).toBe(200);
    const room = await RoomModel.findOne({ code: "Salle X" });
    expect(room).toMatchObject({ name: "Salle X", floor: 2, type: "classroom", status: "free" });
    expect(String(room!.building)).toBe(String(building._id));
    expect(res.body.items.find((p: { place: string }) => p.place === "Salle X")).toMatchObject({ state: "room", via: "name" });
    expect(await ReservationModel.countDocuments({ room: room!._id, status: "active" })).toBe(2);
    expect(await AuditLogModel.countDocuments({ action: "room.create" })).toBe(1);
    // Asking again does not make a second one.
    expect((await setPlace({ place: "Salle X", action: "create" })).status).toBe(200);
    expect(await RoomModel.countDocuments({ code: "Salle X" })).toBe(1);
  });

  it("ignores a place that is not a room, and takes it back", async () => {
    await sync(feed());
    await setPlace({ place: "Salle X", action: "ignore" });
    expect(await places()).toContainEqual(expect.objectContaining({ place: "Salle X", state: "ignored" }));
    expect((await sync(feed())).unmatchedLocations).toEqual([]);
    await setPlace({ place: "Salle X", action: "clear" });
    expect(await places()).toContainEqual(expect.objectContaining({ place: "Salle X", state: "none" }));
  });

  it("creates the rooms by itself on each reading when asked, in the building and floor chosen, once each", async () => {
    const building = (await BuildingModel.findOne({}))!;
    expect((await admin.request("PATCH", `/integrations/${integrationId}`, { autoCreateRooms: true })).status).toBe(400);
    expect((await admin.request("PATCH", `/integrations/${integrationId}`, { autoCreateRooms: true, autoCreateBuildingId: "507f1f77bcf86cd799439011" })).status).toBe(404);
    expect((await admin.request("PATCH", `/integrations/${integrationId}`, { autoCreateRooms: true, autoCreateBuildingId: String(building._id), autoCreateFloor: 1 })).status).toBe(200);
    const long = "Atelier numerique et creativite du campus";
    const calls = calendar([{ uid: "1", location: "Réunion 1-11" }, { uid: "2", location: "Bureau Péda" }, { uid: "3", location: "Pédagogie 1-8" }, { uid: "4", location: long }, { uid: "5", location: "En distanciel (Teams)" }]);
    const summary = await sync(calls);
    expect(summary).toMatchObject({ createdRooms: 3, unmatchedLocations: [] });
    const made = await RoomModel.find({ code: { $in: ["Réunion 1-11", "Bureau Péda", long.slice(0, 30).trim()] } });
    expect(made.map((r) => `${r.code}|${r.type}|${r.floor}`).sort()).toEqual([`Bureau Péda|office|1`, `${long.slice(0, 30).trim()}|other|1`, `Réunion 1-11|meeting|1`].sort());
    expect(made.find((r) => r.code === long.slice(0, 30).trim())!.name).toBe(long);
    expect(await ReservationModel.countDocuments({ status: "active" })).toBe(4);
    // A second reading finds them again and makes nothing.
    expect(await sync(calls)).toMatchObject({ createdRooms: 0, created: 0, updated: 0 });
    expect(await RoomModel.countDocuments()).toBe(4);
  });

  it("does not make a second room for a place that only differs by accents or case", async () => {
    const building = (await BuildingModel.findOne({}))!;
    await admin.request("PATCH", `/integrations/${integrationId}`, { autoCreateRooms: true, autoCreateBuildingId: String(building._id) });
    const summary = await sync(calendar([{ uid: "1", location: "PEDAGOGIE 1-8" }]));
    expect(summary.createdRooms).toBe(0);
    expect(await RoomModel.countDocuments()).toBe(1);
    expect(await ReservationModel.countDocuments({ room: roomId })).toBe(1);
  });
});
