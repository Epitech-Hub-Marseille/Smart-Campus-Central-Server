import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_RESERVATION_MS } from "../reservations.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { BuildingModel } from "../../models/building.js";
import { CommandModel } from "../../models/command.js";
import { DeviceModel } from "../../models/device.js";
import { ReservationModel } from "../../models/reservation.js";
import { RoomModel } from "../../models/room.js";
import { startHarness, type ApiClient, type Harness } from "../../testing/harness.js";

let h: Harness;
let operator: ApiClient;
let staff: ApiClient;
let roomId: string;
let otherRoomId: string;

beforeAll(async () => {
  h = await startHarness();
  [operator, staff] = await Promise.all([h.login("operator"), h.login("staff")]);
}, 120_000);
afterAll(() => h.stop());

beforeEach(async () => {
  await Promise.all([DeviceModel.deleteMany({}), CommandModel.deleteMany({}), RoomModel.deleteMany({}), BuildingModel.deleteMany({}), ReservationModel.deleteMany({}), AuditLogModel.deleteMany({})]);
  const building = await BuildingModel.create({ code: "B2", name: "Building 2" });
  roomId = String((await RoomModel.create({ building: building._id, code: "B2-104", name: "Lab", floor: 1 }))._id);
  otherRoomId = String((await RoomModel.create({ building: building._id, code: "B2-105", floor: 1 }))._id);
});

// One fixed origin: two calls to `at(1)` must be the same instant, or "back to back" would overlap by a few milliseconds.
const T0 = Date.now();
const at = (hoursFromNow: number) => new Date(T0 + hoursFromNow * 3_600_000).toISOString();
const book = (client: ApiClient, body: Partial<{ roomId: string; title: string; start: string; end: string }> = {}) =>
  client.request("POST", "/reservations", { roomId, title: "Algorithms", start: at(1), end: at(2), ...body });

describe("booking a room", () => {
  it("anyone signed in can book, and the reservation names its organiser", async () => {
    const res = await book(staff);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ roomId, title: "Algorithms", organizer: "Test staff", status: "active" });
    expect(await AuditLogModel.countDocuments({ action: "reservation.create" })).toBe(1);
    expect((await h.anonymous.request("POST", "/reservations", {})).status).toBe(401);
  });

  it("refuses an overlapping booking and says what is in the way", async () => {
    await book(operator, { title: "Exam", start: at(1), end: at(3) });
    for (const [start, end] of [[0.5, 1.5], [2, 4], [1.5, 2.5], [0, 5]] as const) {
      const res = await book(staff, { start: at(start), end: at(end) });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already booked: "Exam" \d\d:\d\d-\d\d:\d\d/);
    }
    expect(await ReservationModel.countDocuments()).toBe(1);
  });

  it("back-to-back bookings and other rooms are not conflicts", async () => {
    await book(operator, { start: at(1), end: at(2) });
    expect((await book(staff, { start: at(2), end: at(3) })).status).toBe(201);
    expect((await book(staff, { start: at(0), end: at(1) })).status).toBe(201);
    expect((await book(staff, { roomId: otherRoomId, start: at(1), end: at(2) })).status).toBe(201);
  });

  it("two people booking the same slot at the same moment: exactly one wins", async () => {
    const results = await Promise.all([book(operator), book(staff), book(operator, { title: "Third" }), book(staff, { title: "Fourth" })]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await ReservationModel.countDocuments()).toBe(1);
  });

  it("a cancelled reservation frees the slot", async () => {
    const first = await book(operator);
    await operator.request("DELETE", `/reservations/${first.body.id}`);
    expect((await book(staff)).status).toBe(201);
  });

  it("validates times, length, room and title", async () => {
    expect((await book(staff, { start: at(2), end: at(1) })).status).toBe(400);
    expect((await book(staff, { start: at(1), end: at(1) })).status).toBe(400);
    expect((await book(staff, { start: at(-2), end: at(-1) })).status).toBe(400);
    expect((await book(staff, { start: at(1), end: at(1 + MAX_RESERVATION_MS / 3_600_000 + 1) })).status).toBe(400);
    expect((await book(staff, { start: at(24 * 400), end: at(24 * 400 + 1) })).status).toBe(400);
    expect((await book(staff, { title: "" })).status).toBe(400);
    expect((await book(staff, { start: "tomorrow" })).status).toBe(400);
    expect((await book(staff, { roomId: "000000000000000000000000" })).status).toBe(404);
    expect((await book(staff, { roomId: "nope" })).status).toBe(404);
  });

  it("booking a slot that started a minute ago is allowed (the form takes time to fill)", async () => {
    const res = await book(staff, { start: new Date(Date.now() - 60_000).toISOString(), end: at(1) });
    expect(res.status).toBe(201);
  });
});

describe("cancelling and listing", () => {
  it("the organiser, an operator or an admin cancels; another member of staff cannot", async () => {
    const mine = await book(staff);
    const other = await book(operator, { start: at(5), end: at(6) });
    expect((await staff.request("DELETE", `/reservations/${other.body.id}`)).status).toBe(403);
    expect((await staff.request("DELETE", `/reservations/${mine.body.id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/reservations/${other.body.id}`)).status).toBe(204);
    expect((await operator.request("DELETE", `/reservations/${other.body.id}`)).status).toBe(404);
    const [record] = await ReservationModel.find({ reservationId: other.body.id });
    expect(record).toMatchObject({ status: "cancelled", cancelledByName: "Test operator" });
  });

  it("filters by room, period and organiser, and hides cancelled ones unless asked", async () => {
    await book(staff, { start: at(1), end: at(2) });
    await book(operator, { roomId: otherRoomId, start: at(3), end: at(4) });
    const gone = await book(operator, { start: at(5), end: at(6) });
    await operator.request("DELETE", `/reservations/${gone.body.id}`);

    expect((await staff.request("GET", "/reservations")).body.total).toBe(2);
    expect((await staff.request("GET", `/reservations?room=${roomId}`)).body.items).toHaveLength(1);
    expect((await staff.request("GET", "/reservations?mine=true")).body.items.map((r: { organizer: string }) => r.organizer)).toEqual(["Test staff"]);
    expect((await staff.request("GET", `/reservations?from=${at(2.5)}&to=${at(3.5)}`)).body.items).toHaveLength(1);
    expect((await staff.request("GET", "/reservations?status=cancelled")).body.items).toHaveLength(1);
    const first = (await staff.request("GET", "/reservations")).body.items[0];
    expect(first.room).toEqual({ code: "B2-104", name: "Lab", building: "Building 2" });
  });
});

describe("door screens", () => {
  it("shows the next reservations of its room and follows bookings and cancellations", async () => {
    const { identity, deviceId } = await h.enrollDevice({ room: roomId });
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");
    // Linking the screen to the room already sent an (empty) list.
    expect((await dev.next("reservations.set")).payload.items).toEqual([]);

    const first = await book(operator, { title: "Algorithms", start: at(3), end: at(4) });
    expect((await dev.next("reservations.set")).payload).toMatchObject({ roomId, items: [{ title: "Algorithms", organizer: "Test operator" }] });

    await book(staff, { title: "Databases", start: at(1), end: at(2) });
    expect((await dev.next("reservations.set")).payload.items.map((i) => i.title)).toEqual(["Databases", "Algorithms"]);

    await operator.request("DELETE", `/reservations/${first.body.id}`);
    expect((await dev.next("reservations.set")).payload.items.map((i) => i.title)).toEqual(["Databases"]);
    dev.close();
  });

  it("only the screens of that room hear about it, with at most five items and none from the past or far future", async () => {
    const mine = await h.enrollDevice({ room: roomId });
    const other = await h.enrollDevice({ room: otherRoomId });
    await CommandModel.deleteMany({});
    for (let i = 0; i < 7; i++) await book(operator, { title: `Slot ${i}`, start: at(1 + i), end: at(1.5 + i) });
    await book(operator, { title: "Far away", start: at(24 * 10), end: at(24 * 10 + 1) });

    expect(await CommandModel.countDocuments({ deviceId: other.deviceId, type: "reservations.set" })).toBe(0);
    const latest = await CommandModel.findOne({ deviceId: mine.deviceId, type: "reservations.set", status: { $ne: "superseded" } });
    const items = (latest?.payload as { items: { title: string }[] }).items;
    expect(items.map((i) => i.title)).toEqual(["Slot 0", "Slot 1", "Slot 2", "Slot 3", "Slot 4"]);
  });

  it("a screen that is linked to a room afterwards gets its reservations along with the room", async () => {
    await book(operator, { title: "Algorithms", start: at(1), end: at(2) });
    const { deviceId } = await h.enrollDevice();
    await operator.request("PATCH", `/devices/${deviceId}`, { room: roomId });
    const cmd = await CommandModel.findOne({ deviceId, type: "reservations.set" });
    expect((cmd?.payload as { items: { title: string }[] }).items[0]!.title).toBe("Algorithms");
  });

  it("the reservations are part of the digital twin, so a reconnecting screen sees them at once", async () => {
    const { identity, deviceId } = await h.enrollDevice({ room: roomId });
    await book(operator, { title: "Algorithms", start: at(1), end: at(2) });
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    const ready = await dev.next("session.ready");
    expect((ready.payload.desired.reservations as { items: unknown[] }).items).toHaveLength(1);
    dev.close();
  });
});

describe("Faculty screens", () => {
  it("list what is booked in the next day, in every room", async () => {
    const { identity, deviceId } = await h.enrollDevice({ type: "display" });
    await book(operator, { title: "Algorithms", start: at(1), end: at(2) });
    await book(operator, { roomId: otherRoomId, title: "Databases", start: at(2), end: at(3) });
    await book(operator, { title: "Next week", start: at(24 * 7), end: at(24 * 7 + 1) });

    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");
    const { reservations } = (await dev.next("faculty.content.set")).payload;
    expect(reservations.map((r) => `${r.room} / ${r.title}`)).toEqual(["B2-104 / Algorithms", "B2-105 / Databases"]);
    dev.close();
  });

  it("learn about a new booking at once", async () => {
    const { identity, deviceId } = await h.enrollDevice({ type: "display" });
    const dev = h.connectDevice(deviceId, identity);
    await dev.ready;
    await dev.next("session.ready");
    await dev.next("faculty.content.set");
    await book(operator, { title: "Algorithms" });
    expect((await dev.next("faculty.content.set")).payload.reservations).toHaveLength(1);
    dev.close();
  });
});
