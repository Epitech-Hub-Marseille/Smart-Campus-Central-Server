import { FACULTY_LIMITS } from "@smartcampus/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFacultyContent, effectiveAvailability } from "../faculty.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { NewsModel } from "../../models/news.js";
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

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), NewsModel.deleteMany({}), AuditLogModel.deleteMany({})]);
  await UserModel.deleteMany({ email: { $not: /@test\.local$/ } });
  await UserModel.updateMany({}, { $unset: { service: 1, availability: 1 } });
});

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const staffUser = () => UserModel.findOne({ email: "staff@test.local" }).then((u) => u!);
const addPerson = (name: string, service: "pedagogical" | "administrative") => UserModel.create({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@campus.test`, service, jobTitle: "Teacher" });

describe("news", () => {
  it("is managed by admins and operators and read by everyone signed in", async () => {
    const created = await operator.request("POST", "/faculty/news", { title: "Open day", text: "Saturday 10:00", priority: "important" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Open day", priority: "important", expired: false, createdBy: "Test operator" });

    expect((await staff.request("GET", "/faculty/news")).body).toMatchObject({ screenLimit: FACULTY_LIMITS.news });
    expect((await staff.request("POST", "/faculty/news", { title: "x" })).status).toBe(403);
    expect((await staff.request("DELETE", `/faculty/news/${created.body.id}`)).status).toBe(403);
    expect((await h.anonymous.request("GET", "/faculty/news")).status).toBe(401);

    const edited = await operator.request("PUT", `/faculty/news/${created.body.id}`, { title: "Open day moved", text: "", priority: "info", expiresAt: hours(5) });
    expect(edited.body).toMatchObject({ title: "Open day moved", priority: "info" });
    expect(edited.body.expiresAt).not.toBeNull();
    // null removes the expiry, leaving it out keeps it.
    expect((await operator.request("PUT", `/faculty/news/${created.body.id}`, { title: "Open day moved", expiresAt: null })).body.expiresAt).toBeNull();

    expect((await operator.request("DELETE", `/faculty/news/${created.body.id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/faculty/news/${created.body.id}`)).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: /^faculty\.news/ })).toBe(4);
  });

  it("validates: a title is required, the text fits the screen, an expiry is in the future", async () => {
    expect((await operator.request("POST", "/faculty/news", { title: "" })).status).toBe(400);
    expect((await operator.request("POST", "/faculty/news", { title: "x", text: "y".repeat(401) })).status).toBe(400);
    expect((await operator.request("POST", "/faculty/news", { title: "x", expiresAt: hours(-1) })).status).toBe(400);
  });

  it("the screen gets important items first, newest first, without expired or not yet published ones, up to its limit", async () => {
    const now = Date.now();
    await NewsModel.create([
      { newsId: "n1", title: "old info", priority: "info", publishedAt: new Date(now - 3000), createdByName: "x" },
      { newsId: "n2", title: "new info", priority: "info", publishedAt: new Date(now - 1000), createdByName: "x" },
      { newsId: "n3", title: "urgent", priority: "urgent", publishedAt: new Date(now - 5000), createdByName: "x" },
      { newsId: "n4", title: "expired", priority: "urgent", publishedAt: new Date(now - 9000), expiresAt: new Date(now - 1), createdByName: "x" },
      { newsId: "n5", title: "future", priority: "urgent", publishedAt: new Date(now + 60_000), createdByName: "x" },
    ]);
    expect((await buildFacultyContent("all")).news.map((n) => n.title)).toEqual(["urgent", "new info", "old info"]);

    await NewsModel.insertMany(Array.from({ length: 20 }, (_, i) => ({ newsId: `bulk${i}`, title: `bulk ${i}`, publishedAt: new Date(now - 100 - i), createdByName: "x" })));
    expect((await buildFacultyContent("all")).news).toHaveLength(FACULTY_LIMITS.news);
  });
});

describe("staff availability", () => {
  it("only people with a service are listed, and the list filters by service", async () => {
    await addPerson("Alice Martin", "pedagogical");
    await addPerson("Bruno Petit", "administrative");
    await UserModel.create({ name: "Not listed", email: "nl@campus.test" });
    await UserModel.create({ name: "Disabled", email: "d@campus.test", service: "pedagogical", disabled: true });

    const all = (await staff.request("GET", "/faculty/staff")).body.items.map((p: { name: string }) => p.name);
    expect(all).toEqual(["Alice Martin", "Bruno Petit"]);
    const admin_ = (await staff.request("GET", "/faculty/staff?service=administrative")).body.items;
    expect(admin_.map((p: { name: string }) => p.name)).toEqual(["Bruno Petit"]);
    expect((await staff.request("GET", "/faculty/staff?service=cleaning")).status).toBe(400);
  });

  it("assigning a service happens through the staff directory and is limited to admins and operators", async () => {
    const person = await UserModel.create({ name: "Carla Roy", email: "carla@campus.test" });
    expect((await staff.request("PATCH", `/users/${person.id}`, { service: "pedagogical" })).status).toBe(403);
    expect((await operator.request("PATCH", `/users/${person.id}`, { service: "pedagogical" })).body).toMatchObject({ service: "pedagogical" });
    expect((await operator.request("PATCH", `/users/${person.id}`, { service: "teaching" })).status).toBe(400);
    expect((await operator.request("PATCH", `/users/${person.id}`, { service: null })).body.service).toBeNull();
    expect((await UserModel.findById(person.id))?.service).toBeUndefined();
  });

  it("a person updates their own availability, with a note and an end time", async () => {
    await UserModel.updateOne({ email: "staff@test.local" }, { service: "pedagogical" });
    expect((await staff.request("GET", "/faculty/availability/me")).body).toMatchObject({ listed: true, availability: "available" });

    const res = await staff.request("PUT", "/faculty/availability/me", { status: "away", note: "Back after lunch", until: hours(2) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ availability: "away", note: "Back after lunch", service: "pedagogical" });
    expect(res.body.until).not.toBeNull();

    // Becoming available again drops the note and the end time, which would otherwise linger on the screens.
    const back = await staff.request("PUT", "/faculty/availability/me", { status: "available", note: "stale", until: hours(3) });
    expect(back.body).toMatchObject({ availability: "available", note: "", until: null });
  });

  it("refuses an end time in the past, an unknown status, and someone who is not listed", async () => {
    expect((await staff.request("PUT", "/faculty/availability/me", { status: "away" })).status).toBe(409);
    expect((await staff.request("GET", "/faculty/availability/me")).body).toEqual({ listed: false });
    await UserModel.updateOne({ email: "staff@test.local" }, { service: "pedagogical" });
    expect((await staff.request("PUT", "/faculty/availability/me", { status: "away", until: hours(-1) })).status).toBe(400);
    expect((await staff.request("PUT", "/faculty/availability/me", { status: "dancing" })).status).toBe(400);
    expect((await staff.request("PUT", "/faculty/availability/me", { status: "away", note: "x".repeat(61) })).status).toBe(400);
  });

  it("staff cannot set someone else's, an operator can and it is audited", async () => {
    const person = await addPerson("Dora Lang", "pedagogical");
    expect((await staff.request("PUT", `/faculty/availability/${person.id}`, { status: "busy" })).status).toBe(403);
    const res = await operator.request("PUT", `/faculty/availability/${person.id}`, { status: "busy", note: "In a meeting" });
    expect(res.body.availability).toBe("busy");
    expect(await AuditLogModel.countDocuments({ action: "faculty.availability.set", targetId: person.id })).toBe(1);
    expect((await operator.request("PUT", "/faculty/availability/not-an-id", { status: "busy" })).status).toBe(404);
  });

  it("a status with an end time that has passed shows the person as available again", () => {
    const user = { _id: "1", name: "Eve", service: "pedagogical", availability: { status: "away", note: "Lunch", until: new Date(Date.now() - 1000) } };
    expect(effectiveAvailability(user)).toEqual({ id: "1", name: "Eve", service: "pedagogical", availability: "available" });
    const still = effectiveAvailability({ ...user, availability: { ...user.availability, until: new Date(Date.now() + 60_000) } });
    expect(still).toMatchObject({ availability: "away", note: "Lunch" });
  });

  it("keeps the screen snapshot within the protocol limits however many people there are", async () => {
    await UserModel.insertMany(Array.from({ length: FACULTY_LIMITS.staff + 10 }, (_, i) => ({ name: `Person ${String(i).padStart(3, "0")}`, email: `p${i}@campus.test`, service: "pedagogical" })));
    const content = await buildFacultyContent("all");
    expect(content.staff).toHaveLength(FACULTY_LIMITS.staff);
    expect(content.staff[0]!.name).toBe("Person 000");
  });
});

describe("Faculty screens", () => {
  it("receives its configuration and the content, and then every change", async () => {
    const { identity, deviceId } = await h.enrollDevice({ type: "display" });
    await addPerson("Alice Martin", "pedagogical");
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");
    // The content is rebuilt when the screen connects.
    expect((await dev.next("faculty.content.set")).payload.staff.map((s) => s.name)).toEqual(["Alice Martin"]);
    // And its look and carousel, which have nothing configured yet.
    expect((await dev.next("faculty.config.set")).payload.config.widgets.weather).toBe(false);
    await dev.next("carousel.set");

    const config = { service: "all", widgets: { clock: true, date: true, weather: true }, weather: { label: "Marseille", latitude: 43.3, longitude: 5.4 } };
    expect((await operator.request("PUT", `/faculty/scopes/device/${deviceId}/config`, config)).status).toBe(204);
    const configured = await dev.next("faculty.config.set");
    expect(configured.payload.config).toMatchObject({ carousel: { enabled: true }, widgets: { weather: true }, weather: { label: "Marseille" } });
    await dev.next("faculty.content.set");

    await operator.request("POST", "/faculty/news", { title: "Library closed Friday", priority: "important" });
    expect((await dev.next("faculty.content.set")).payload.news.map((n) => n.title)).toEqual(["Library closed Friday"]);

    const person = await addPerson("Bruno Petit", "administrative");
    await operator.request("PUT", `/faculty/availability/${person.id}`, { status: "absent", note: "On leave" });
    const update = await dev.next("faculty.content.set");
    expect(update.payload.staff.find((s) => s.name === "Bruno Petit")).toMatchObject({ availability: "absent", note: "On leave", service: "administrative" });
    dev.close();
  });

  it("a screen dedicated to one service only receives that service's staff", async () => {
    const { identity, deviceId } = await h.enrollDevice({ type: "display" });
    await addPerson("Alice Martin", "pedagogical");
    await addPerson("Bruno Petit", "administrative");
    await operator.request("PUT", `/faculty/scopes/device/${deviceId}/config`, { service: "administrative" });

    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");
    expect((await dev.next("faculty.content.set")).payload.staff.map((s) => s.name)).toEqual(["Bruno Petit"]);
    dev.close();
  });

  it("an offline screen gets one fresh snapshot on reconnection, not the stale ones", async () => {
    const { identity, deviceId } = await h.enrollDevice({ type: "display" });
    await operator.request("POST", "/faculty/news", { title: "First" });
    await operator.request("POST", "/faculty/news", { title: "Second" });
    expect(await CommandModel.countDocuments({ deviceId, type: "faculty.content.set", status: "superseded" })).toBeGreaterThanOrEqual(1);

    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    const ready = await dev.next("session.ready");
    expect(ready.payload.desired.facultyContent).toBeUndefined(); // too big for session.ready: rebuilt instead
    const snapshots = dev.inbox.filter((m) => m.type === "faculty.content.set");
    expect(snapshots.length).toBeLessThanOrEqual(1);
    const content = await dev.next("faculty.content.set");
    expect(content.payload.news.map((n) => n.title).sort()).toEqual(["First", "Second"]);
    dev.close();
  });

  it("door screens and readers get nothing from the Faculty feed", async () => {
    const door = await h.enrollDevice({ type: "door" });
    const reader = await h.enrollDevice({ type: "access" });
    await operator.request("POST", "/faculty/news", { title: "Hello" });
    expect(await CommandModel.countDocuments({ deviceId: { $in: [door.deviceId, reader.deviceId] }, type: /^faculty/ })).toBe(0);
  });

  it("only a Faculty display has a Faculty configuration, and the configuration is validated", async () => {
    const door = await h.enrollDevice({ type: "door" });
    const display = await h.enrollDevice({ type: "display" });
    expect((await operator.request("PUT", `/faculty/scopes/device/${door.deviceId}/config`, {})).status).toBe(404);
    expect((await operator.request("PUT", "/faculty/scopes/device/nope/config", {})).status).toBe(404);
    for (const bad of [{ mode: "custom" }, { carousel: { slides: ["news"] } }, { service: "cleaning" }, { weather: { label: "", latitude: 200, longitude: 0 } }]) {
      expect((await operator.request("PUT", `/faculty/scopes/device/${display.deviceId}/config`, bad)).status).toBe(400);
    }
    expect((await staff.request("PUT", `/faculty/scopes/device/${display.deviceId}/config`, {})).status).toBe(403);
  });

  it("changing a person's service or disabling them updates the screens", async () => {
    const display = await h.enrollDevice({ type: "display" });
    const person = await addPerson("Alice Martin", "pedagogical");
    await CommandModel.deleteMany({});
    await admin.request("PATCH", `/users/${person.id}`, { disabled: true });
    const cmd = await CommandModel.findOne({ deviceId: display.deviceId, type: "faculty.content.set", status: { $ne: "superseded" } });
    expect((cmd?.payload as { staff: unknown[] }).staff).toHaveLength(0);
  });
});
