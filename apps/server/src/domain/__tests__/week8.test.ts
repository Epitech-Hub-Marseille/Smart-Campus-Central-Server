import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { watchDevices } from "../deviceAlerts.js";
import { DeviceRegistry } from "../../gateway/registry.js";
import { AuditLogModel } from "../../models/auditLog.js";
import { MessageModel } from "../../models/message.js";
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

const send = (client: ApiClient, over: Record<string, unknown> = {}) =>
  client.request("POST", "/messages", { subject: "Fire drill", body: "At 10:00, building A.", audience: { kind: "everyone" }, ...over });

describe("internal messages", () => {
  beforeEach(() => MessageModel.deleteMany({}));

  it("reaches everyone with an account except the sender, and each person reads only their own inbox", async () => {
    const sent = await send(admin);
    expect(sent.status).toBe(201);
    expect(sent.body.recipientCount).toBe(2);

    const mine = await staff.request("GET", "/messages/inbox");
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ subject: "Fire drill", sender: "Test admin", readAt: null });
    expect(mine.body.unread).toBe(1);
    // The sender does not receive their own message.
    expect((await admin.request("GET", "/messages/inbox")).body.items).toHaveLength(0);
  });

  it("targets a role or chosen people, and refuses an audience nobody belongs to", async () => {
    await send(admin, { audience: { kind: "roles", roles: ["operator"] } });
    expect((await operator.request("GET", "/messages/inbox")).body.items).toHaveLength(1);
    expect((await staff.request("GET", "/messages/inbox")).body.items).toHaveLength(0);

    const staffUser = await UserModel.findOne({ email: "staff@test.local" });
    await send(admin, { audience: { kind: "users", userIds: [staffUser!.id] } });
    expect((await staff.request("GET", "/messages/inbox")).body.items).toHaveLength(1);

    const nobody = await send(admin, { audience: { kind: "users", userIds: ["000000000000000000000000"] } });
    expect(nobody.status).toBe(400);
  });

  it("does not deliver to disabled accounts or accounts that cannot sign in", async () => {
    const disabled = await UserModel.create({ email: "gone@test.local", name: "Gone", groups: [], disabled: true });
    const cardOnly = await UserModel.create({ name: "Card only", groups: ["student"] });
    try {
      const sent = await send(admin);
      const detail = await admin.request("GET", `/messages/sent/${sent.body.id}`);
      const names = detail.body.recipients.map((r: { name: string }) => r.name);
      expect(names).not.toContain("Gone");
      expect(names).not.toContain("Card only");
    } finally {
      await UserModel.deleteMany({ _id: { $in: [disabled._id, cardOnly._id] } });
    }
  });

  it("records a read receipt once, keeps the first reading time, and shows it to the sender", async () => {
    const sent = await send(admin);
    expect((await staff.request("POST", `/messages/${sent.body.id}/read`)).status).toBe(204);
    const first = (await admin.request("GET", `/messages/sent/${sent.body.id}`)).body;
    expect(first.readCount).toBe(1);
    const reader = first.recipients.find((r: { name: string }) => r.name === "Test staff");
    expect(reader.readAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 20));
    await staff.request("POST", `/messages/${sent.body.id}/read`);
    const again = (await admin.request("GET", `/messages/sent/${sent.body.id}`)).body;
    expect(again.recipients.find((r: { name: string }) => r.name === "Test staff").readAt).toBe(reader.readAt);
    expect(again.recipients.find((r: { name: string }) => r.name === "Test operator").readAt).toBeNull();

    expect((await staff.request("GET", "/messages/unread-count")).body.unread).toBe(0);
  });

  it("marks everything read at once, only for the person asking", async () => {
    await send(admin);
    await send(admin, { subject: "Second" });
    expect((await staff.request("POST", "/messages/read-all")).body.marked).toBe(2);
    expect((await staff.request("GET", "/messages/unread-count")).body.unread).toBe(0);
    expect((await operator.request("GET", "/messages/unread-count")).body.unread).toBe(2);
  });

  it("answers 404 for a message that is not addressed to you, so other messages cannot be probed", async () => {
    const sent = await send(admin, { audience: { kind: "roles", roles: ["operator"] } });
    expect((await staff.request("POST", `/messages/${sent.body.id}/read`)).status).toBe(404);
  });

  it("only administrators and operators write, and only the author (or an administrator) sees the receipts", async () => {
    expect((await send(staff)).status).toBe(403);
    expect((await h.anonymous.request("GET", "/messages/inbox")).status).toBe(401);

    const fromOperator = await send(operator);
    expect((await operator.request("GET", `/messages/sent/${fromOperator.body.id}`)).status).toBe(200);
    expect((await admin.request("GET", `/messages/sent/${fromOperator.body.id}`)).status).toBe(200);
    const fromAdmin = await send(admin);
    expect((await operator.request("GET", `/messages/sent/${fromAdmin.body.id}`)).status).toBe(404);
    expect((await staff.request("GET", `/messages/sent/${fromAdmin.body.id}`)).status).toBe(403);
  });

  it("validates the body and writes an audit entry", async () => {
    expect((await send(admin, { subject: " " })).status).toBe(400);
    expect((await send(admin, { audience: { kind: "roles", roles: [] } })).status).toBe(400);
    expect((await send(admin, { priority: "loud" })).status).toBe(400);
    const sent = await send(admin);
    expect(await AuditLogModel.countDocuments({ action: "message.send", targetId: sent.body.id })).toBe(1);
  });
});

describe("audit log", () => {
  it("is for administrators only, filterable, and paginated", async () => {
    expect((await operator.request("GET", "/audit")).status).toBe(403);
    expect((await staff.request("GET", "/audit")).status).toBe(403);
    await AuditLogModel.create([
      { actorName: "Alice", action: "room.status", targetType: "room", targetId: "r1" },
      { actorName: "Bob", action: "room.update", targetType: "room", targetId: "r2" },
      { actorName: "Alice", action: "device.revoke", targetType: "device", targetId: "d1" },
    ]);
    const byAction = (await admin.request("GET", "/audit?action=room.")).body;
    expect(byAction.items.every((e: { action: string }) => e.action.startsWith("room."))).toBe(true);
    expect(byAction.total).toBeGreaterThanOrEqual(2);
    const byActor = (await admin.request("GET", "/audit?actor=alic")).body;
    expect(byActor.items.every((e: { actor: string }) => e.actor === "Alice")).toBe(true);
    expect(byActor.actions).toContain("device.revoke");
    expect((await admin.request("GET", "/audit?limit=1&page=2")).body.items).toHaveLength(1);
    // Text typed by a person is never a regular expression.
    expect((await admin.request("GET", "/audit?actor=.*")).body.total).toBe(0);
    expect((await admin.request("GET", "/audit?from=not-a-date")).status).toBe(400);
  });
});

describe("statistics", () => {
  it("gives the overview to administrators and operators, with activity only for administrators", async () => {
    const asAdmin = await admin.request("GET", "/stats/overview");
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toMatchObject({ devices: { active: expect.any(Number) }, rooms: { total: expect.any(Number) }, emergencies: { active: 0 } });
    expect(asAdmin.body.activity.length).toBeGreaterThan(0);
    const asOperator = await operator.request("GET", "/stats/overview");
    expect(asOperator.status).toBe(200);
    expect(asOperator.body.activity).toEqual([]);
    expect((await staff.request("GET", "/stats/overview")).status).toBe(403);
  });

  it("exports CSV, defuses formulas, audits the export, and keeps the audit dataset for administrators", async () => {
    await send(admin, { subject: "=cmd|' /C calc'!A0" });
    const res = await admin.raw("GET", "/stats/export/messages");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="smartcampus-messages-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    // The byte order mark is what makes Excel read accents as UTF-8 (fetch's text() would swallow it).
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text).toContain("sent;subject;priority;sender;recipients;read");
    expect(text).toContain("'=cmd|' /C calc'!A0");
    expect(await AuditLogModel.countDocuments({ action: "stats.export", targetId: "messages" })).toBe(1);

    expect((await operator.raw("GET", "/stats/export/devices")).status).toBe(200);
    expect((await operator.raw("GET", "/stats/export/audit")).status).toBe(403);
    expect((await admin.raw("GET", "/stats/export/audit")).status).toBe(200);
    expect((await admin.raw("GET", "/stats/export/nope")).status).toBe(404);
    expect((await admin.raw("GET", "/stats/export/constructor")).status).toBe(404);
    expect((await staff.raw("GET", "/stats/export/devices")).status).toBe(403);
  });

  it("limits an export to a period", async () => {
    const empty = await admin.raw("GET", "/stats/export/messages?from=2000-01-01&to=2000-01-02");
    expect((await empty.text()).trim().split(/\r?\n/)).toHaveLength(1);
  });
});

describe("offline device alerts", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alerts = (action: string, id: string) => AuditLogModel.countDocuments({ action, targetId: id });

  it("stay quiet for a short drop, alert managers once for a real outage, and record the return", async () => {
    await MessageModel.deleteMany({});
    const { deviceId } = await h.enrollDevice();
    const registry = new DeviceRegistry();
    const stop = watchDevices(registry, 80);
    try {
      // A blip shorter than the grace period raises nothing.
      registry.emit("offline", deviceId);
      await settle(30);
      registry.emit("online", deviceId);
      await settle(120);
      expect(await alerts("device.offline", deviceId)).toBe(0);

      // A real outage: one audit entry and one message, however many times it is reported.
      registry.emit("offline", deviceId);
      registry.emit("offline", deviceId);
      await settle(250);
      expect(await alerts("device.offline", deviceId)).toBe(1);
      const messages = await MessageModel.find({ subject: /is offline/ });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ senderName: "Smart Campus", priority: "important" });
      expect(messages[0]!.audience.roles.sort()).toEqual(["admin", "operator"]);
      // Staff are not told: it is of no use to them.
      expect((await staff.request("GET", "/messages/inbox")).body.items).toHaveLength(0);
      expect((await operator.request("GET", "/messages/inbox")).body.items.length).toBeGreaterThan(0);

      registry.emit("online", deviceId);
      await settle(150);
      expect(await alerts("device.online", deviceId)).toBe(1);
    } finally {
      stop();
    }
  });

  it("does not alert for a device that was revoked on purpose", async () => {
    const { deviceId } = await h.enrollDevice();
    await admin.request("POST", `/devices/${deviceId}/revoke`);
    const registry = new DeviceRegistry();
    const stop = watchDevices(registry, 40);
    try {
      registry.emit("offline", deviceId);
      await settle(200);
      expect(await alerts("device.offline", deviceId)).toBe(0);
    } finally {
      stop();
    }
  });
});
