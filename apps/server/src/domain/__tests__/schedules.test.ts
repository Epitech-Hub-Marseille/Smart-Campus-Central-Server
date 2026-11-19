import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MISSED_RUN_GRACE_MS, STATUS_TRIGGER_COOLDOWN_MS, fireStatusSchedules, runDueSchedules } from "../schedules.js";
import { setTtsEngine } from "../../infra/tts.js";
import { AnnouncementModel } from "../../models/announcement.js";
import { AnnouncementTemplateModel } from "../../models/announcementTemplate.js";
import { AssetModel } from "../../models/asset.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { BuildingModel } from "../../models/building.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { RoomModel } from "../../models/room.js";
import { ScheduleModel } from "../../models/schedule.js";
import { fakeEngine } from "../../testing/fakeTts.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let operator: ApiClient;
let staff: ApiClient;

beforeAll(async () => {
  h = await startHarness();
  [operator, staff] = await Promise.all([h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([
    DeviceModel.deleteMany({}),
    CommandModel.deleteMany({}),
    RoomModel.deleteMany({}),
    BuildingModel.deleteMany({}),
    AnnouncementModel.deleteMany({}),
    AnnouncementTemplateModel.deleteMany({}),
    AssetModel.deleteMany({}),
    ScheduleModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});
afterEach(() => setTtsEngine(undefined));

const content = { kind: "text", title: "Reminder", text: "Doors close at 18:00", priority: "important" };
const create = (body: object, client = operator) => client.request("POST", "/schedules", body);
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

describe("announcement templates", () => {
  const template = { name: "Closing", text: "The building closes in 10 minutes", priority: "urgent" };

  it("creates, edits and deletes with an audit trail", async () => {
    const created = await operator.request("POST", "/announcement-templates", template);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Closing", kind: "text", priority: "urgent", createdBy: "Test operator" });

    const edited = await operator.request("PUT", `/announcement-templates/${created.body.id}`, { ...template, name: "Closing soon", kind: "voice", voice: "nova" });
    expect(edited.body).toMatchObject({ name: "Closing soon", kind: "voice", voice: "nova" });
    expect((await operator.request("GET", "/announcement-templates")).body.items).toHaveLength(1);

    expect((await operator.request("DELETE", `/announcement-templates/${created.body.id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/announcement-templates/${created.body.id}`)).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: /^template\./ })).toBe(3);
  });

  it("refuses a name used already in any letter case, bad input, and a voice text the engine would refuse", async () => {
    await operator.request("POST", "/announcement-templates", template);
    expect((await operator.request("POST", "/announcement-templates", { ...template, name: "CLOSING" })).status).toBe(409);
    expect((await operator.request("POST", "/announcement-templates", { ...template, name: "" })).status).toBe(400);
    expect((await operator.request("POST", "/announcement-templates", { ...template, name: "X", priority: "loud" })).status).toBe(400);
    expect((await operator.request("POST", "/announcement-templates", { ...template, name: "V", kind: "voice", text: "x".repeat(1001) })).status).toBe(400);
  });

  it("is a management tool: staff cannot even read it", async () => {
    expect((await staff.request("GET", "/announcement-templates")).status).toBe(403);
    expect((await h.anonymous.request("GET", "/announcement-templates")).status).toBe(401);
  });
});

describe("creating schedules", () => {
  it("computes the next run of a daily schedule and stores the content as a snapshot", async () => {
    const { deviceId } = await h.enrollDevice();
    const res = await create({ name: "Evening notice", content, trigger: { type: "daily", time: "18:00" }, targets: { devices: [deviceId] } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ enabled: true, runCount: 0, content: { kind: "text", text: "Doors close at 18:00" } });
    expect(new Date(res.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.body.nextRunAt).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("builds a schedule from a template, which later edits do not change", async () => {
    const { deviceId } = await h.enrollDevice();
    const t = (await operator.request("POST", "/announcement-templates", { name: "T", text: "Original", priority: "info" })).body;
    const res = await create({ name: "From template", templateId: t.id, expiresAfterMinutes: 30, trigger: { type: "weekly", time: "09:00", days: [3, 1, 3] }, targets: { devices: [deviceId] } });
    expect(res.body.content).toMatchObject({ text: "Original", expiresAfterMinutes: 30 });
    expect(res.body.trigger.days).toEqual([1, 3]);

    await operator.request("PUT", `/announcement-templates/${t.id}`, { name: "T", text: "Changed", priority: "info" });
    expect((await ScheduleModel.findOne())?.content.text).toBe("Original");
  });

  it("refuses what could never run: unknown template, both or neither of content and template, no targets, past date, unknown status", async () => {
    const { deviceId } = await h.enrollDevice();
    const targets = { devices: [deviceId] };
    const daily = { type: "daily", time: "08:00" };
    expect((await create({ name: "a", templateId: "nope", trigger: daily, targets })).status).toBe(400);
    expect((await create({ name: "a", trigger: daily, targets })).status).toBe(400);
    const t = (await operator.request("POST", "/announcement-templates", { name: "T", text: "x" })).body;
    expect((await create({ name: "a", templateId: t.id, content, trigger: daily, targets })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: daily })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: { type: "once", at: minutes(-5) }, targets })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: { type: "status", status: "no-such-status" } })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: { type: "daily", time: "25:00" }, targets })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: { type: "weekly", time: "08:00", days: [] }, targets })).status).toBe(400);
    expect((await create({ name: "a", content, trigger: { type: "daily", time: "08:00", extra: 1 }, targets })).status).toBe(400);
    expect(await ScheduleModel.countDocuments()).toBe(0);
  });

  it("a voice schedule needs the voice engine and a text it can read, and does not expire", async () => {
    const { deviceId } = await h.enrollDevice();
    const voice = { kind: "voice", text: "Hello" };
    const body = { name: "v", content: voice, trigger: { type: "daily", time: "08:00" }, targets: { devices: [deviceId] } };
    setTtsEngine(null);
    expect((await create(body)).status).toBe(501);
    setTtsEngine(fakeEngine());
    expect((await create(body)).status).toBe(201);
    expect((await create({ ...body, content: { ...voice, expiresAfterMinutes: 5 } })).status).toBe(400);
  });

  it("only admins and operators manage schedules", async () => {
    const { deviceId } = await h.enrollDevice();
    const body = { name: "s", content, trigger: { type: "daily", time: "08:00" }, targets: { devices: [deviceId] } };
    expect((await create(body, staff)).status).toBe(403);
    expect((await staff.request("GET", "/schedules")).status).toBe(403);
    expect((await h.anonymous.request("GET", "/schedules")).status).toBe(401);
  });
});

describe("running schedules", () => {
  async function dueSchedule(trigger: object = { type: "daily", time: "08:00" }, minutesLate = 1) {
    const { identity, deviceId } = await h.enrollDevice();
    const res = await create({ name: "Notice", content: { ...content, expiresAfterMinutes: 60 }, trigger, targets: { devices: [deviceId] } });
    await ScheduleModel.updateOne({ scheduleId: res.body.id }, { $set: { nextRunAt: minutes(-minutesLate) } });
    return { id: res.body.id as string, deviceId, identity };
  }

  it("announces on the screens, moves the next run forward and audits it as a scheduled action", async () => {
    const { id, deviceId } = await dueSchedule();
    expect(await runDueSchedules()).toBe(1);

    const announcement = await AnnouncementModel.findOne();
    expect(announcement).toMatchObject({ text: "Doors close at 18:00", priority: "important", createdByName: "Notice (scheduled)" });
    expect(announcement?.deviceIds).toEqual([deviceId]);
    expect(announcement?.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 55 * 60_000);

    const schedule = await ScheduleModel.findOne({ scheduleId: id });
    expect(schedule?.runCount).toBe(1);
    expect(schedule?.lastError).toBeUndefined();
    expect(schedule!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await AuditLogModel.countDocuments({ action: "schedule.run", targetId: id })).toBe(1);
    expect(await runDueSchedules()).toBe(0);
  });

  it("two processes ticking at once run it only once", async () => {
    await dueSchedule();
    const ran = await Promise.all([runDueSchedules(), runDueSchedules(), runDueSchedules()]);
    expect(ran.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await AnnouncementModel.countDocuments()).toBe(1);
  });

  it("a one-time schedule runs once and then has nothing left to run", async () => {
    const { id } = await dueSchedule({ type: "once", at: minutes(60) });
    await runDueSchedules();
    expect((await ScheduleModel.findOne({ scheduleId: id }))?.nextRunAt).toBeNull();
    expect(await runDueSchedules()).toBe(0);
    expect(await AnnouncementModel.countDocuments()).toBe(1);
  });

  it("skips a run the server missed by too long instead of announcing it late, and says so", async () => {
    const { id } = await dueSchedule({ type: "daily", time: "08:00" }, MISSED_RUN_GRACE_MS / 60_000 + 5);
    expect(await runDueSchedules()).toBe(0);
    expect(await AnnouncementModel.countDocuments()).toBe(0);
    const schedule = await ScheduleModel.findOne({ scheduleId: id });
    expect(schedule?.lastError).toMatch(/Missed run/);
    expect(schedule!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a paused schedule does not run, and resuming starts from now rather than replaying", async () => {
    const { id } = await dueSchedule();
    expect((await operator.request("PATCH", `/schedules/${id}`, { enabled: false })).body).toMatchObject({ enabled: false, nextRunAt: null });
    expect(await runDueSchedules()).toBe(0);
    const resumed = (await operator.request("PATCH", `/schedules/${id}`, { enabled: true })).body;
    expect(new Date(resumed.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(await runDueSchedules()).toBe(0);
  });

  it("a failing run is recorded on the schedule and does not stop the others", async () => {
    const { id, deviceId } = await dueSchedule();
    await DeviceModel.updateOne({ deviceId }, { $set: { status: "revoked" } });
    await dueSchedule();
    expect(await runDueSchedules()).toBe(2);
    expect((await ScheduleModel.findOne({ scheduleId: id }))?.lastError).toMatch(/No active screen/);
    expect(await AnnouncementModel.countDocuments()).toBe(1);
  });

  it("a voice schedule speaks the text", async () => {
    const engine = fakeEngine();
    setTtsEngine(engine);
    const { deviceId } = await h.enrollDevice();
    const res = await create({ name: "Voice", content: { kind: "voice", text: "Bonjour", voice: "nova" }, trigger: { type: "daily", time: "08:00" }, targets: { devices: [deviceId] } });
    await ScheduleModel.updateOne({ scheduleId: res.body.id }, { $set: { nextRunAt: minutes(-1) } });
    await runDueSchedules();
    expect(engine.calls).toEqual([{ text: "Bonjour", voice: "nova", language: "fr" }]);
    expect(await CommandModel.countDocuments({ deviceId, type: "audio.play" })).toBe(1);
  });

  it("a voice schedule with a chime asks for audio it can put the chime in front of, and refuses an unknown severity", async () => {
    const engine = fakeEngine({ pcm16: true });
    setTtsEngine(engine);
    const { deviceId } = await h.enrollDevice();
    const body = { name: "Chimed", content: { kind: "voice", text: "Bonjour", voice: "nova", chime: "important" }, trigger: { type: "daily", time: "08:00" }, targets: { devices: [deviceId] } };
    const res = await create(body);
    expect(res.status).toBe(201);
    expect(res.body.content.chime).toBe("important");
    await ScheduleModel.updateOne({ scheduleId: res.body.id }, { $set: { nextRunAt: minutes(-1) } });
    await runDueSchedules();
    expect(engine.calls[0]).toMatchObject({ format: "wav" });
    expect((await create({ ...body, name: "Loud", content: { ...body.content, chime: "deafening" } })).status).toBe(400);
  });

  it("runs now on request and rejects a status schedule, which has no fixed screens", async () => {
    const { id } = await dueSchedule();
    const next = (await ScheduleModel.findOne({ scheduleId: id }))!.nextRunAt;
    const run = await operator.request("POST", `/schedules/${id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.runCount).toBe(1);
    expect((await ScheduleModel.findOne({ scheduleId: id }))!.nextRunAt).toEqual(next);

    const status = await create({ name: "On close", content, trigger: { type: "status", status: "closed" } });
    expect((await operator.request("POST", `/schedules/${status.body.id}/run`)).status).toBe(400);
  });

  it("deletes with an audit entry", async () => {
    const { id } = await dueSchedule();
    expect((await operator.request("DELETE", `/schedules/${id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/schedules/${id}`)).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: "schedule.delete" })).toBe(1);
  });
});

describe("status triggers", () => {
  let roomId: string;
  let otherRoomId: string;
  let doorId: string;

  beforeEach(async () => {
    const building = await BuildingModel.create({ code: "A", name: "A" });
    roomId = String((await RoomModel.create({ building: building._id, code: "A1", floor: 0 }))._id);
    otherRoomId = String((await RoomModel.create({ building: building._id, code: "A2", floor: 0 }))._id);
    doorId = (await h.enrollDevice({ room: roomId })).deviceId;
    await h.enrollDevice({ room: otherRoomId });
  });

  const onClosed = (extra: object = {}) =>
    create({ name: "Room closed", content: { kind: "text", text: "This room is closed", priority: "important" }, trigger: { type: "status", status: "closed", ...extra } });

  it("announces on the screens of the room that changed, and only there", async () => {
    await onClosed();
    expect((await operator.request("PUT", `/rooms/${roomId}/status`, { status: "closed" })).status).toBe(200);
    const announcement = await AnnouncementModel.findOne();
    expect(announcement?.deviceIds).toEqual([doorId]);
    expect(announcement?.text).toBe("This room is closed");
  });

  it("ignores other statuses, and can be limited to one room", async () => {
    await onClosed({ roomId: otherRoomId });
    await operator.request("PUT", `/rooms/${roomId}/status`, { status: "closed" });
    await operator.request("PUT", `/rooms/${otherRoomId}/status`, { status: "occupied" });
    expect(await AnnouncementModel.countDocuments()).toBe(0);
    await operator.request("PUT", `/rooms/${otherRoomId}/status`, { status: "closed" });
    expect(await AnnouncementModel.countDocuments()).toBe(1);
  });

  it("does not fire again within the cooldown, so a flapping status cannot flood the screens", async () => {
    await onClosed();
    await operator.request("PUT", `/rooms/${roomId}/status`, { status: "closed" });
    await operator.request("PUT", `/rooms/${roomId}/status`, { status: "free" });
    await operator.request("PUT", `/rooms/${roomId}/status`, { status: "closed" });
    expect(await AnnouncementModel.countDocuments()).toBe(1);
    await fireStatusSchedules(roomId, "closed", new Date(Date.now() + STATUS_TRIGGER_COOLDOWN_MS + 1000));
    expect(await AnnouncementModel.countDocuments()).toBe(2);
  });

  it("a room without a screen records the problem and the status change still succeeds", async () => {
    const building = await BuildingModel.findOne();
    const lonely = String((await RoomModel.create({ building: building!._id, code: "A3", floor: 0 }))._id);
    await onClosed();
    expect((await operator.request("PUT", `/rooms/${lonely}/status`, { status: "closed" })).status).toBe(200);
    expect((await ScheduleModel.findOne())?.lastError).toMatch(/No screen is linked/);
  });

  it("a paused status schedule stays quiet", async () => {
    const { body } = await onClosed();
    await operator.request("PATCH", `/schedules/${body.id}`, { enabled: false });
    await operator.request("PUT", `/rooms/${roomId}/status`, { status: "closed" });
    expect(await AnnouncementModel.countDocuments()).toBe(0);
  });
});
