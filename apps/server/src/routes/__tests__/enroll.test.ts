import { generateIdentity } from "@smartcampus/handshake";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../../testing/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(() => h.stop());

describe("enrollment rate limits", () => {
  it("lets a waiting device check its request every few seconds for as long as it takes an admin to answer", async () => {
    const created = await h.anonymous.request("POST", "/enroll", { publicKey: generateIdentity().publicKey, type: "display", name: "Screen" });
    expect(created.status).toBe(201);
    const id = created.body.deviceId;
    // Far more than the 20 requests of the limit on asking to be enrolled: a poll every 3 s for a minute is 20, for an hour 1200.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) statuses.push((await h.anonymous.request("GET", `/enroll/${id}`)).status);
    expect(statuses.map((s, i) => `${i}:${s}`).filter((x) => !x.endsWith(":200"))).toEqual([]);
    expect((await h.anonymous.request("GET", `/enroll/${id}`)).body).toEqual({ status: "pending" });
  });

  it("still limits asking to be enrolled, which is what writes a record", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await h.anonymous.request("POST", "/enroll", { publicKey: "x".repeat(10), type: "display" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("limits status checks too, per minute, so the endpoint stays cheap to defend", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push((await h.anonymous.request("GET", "/enroll/nobody")).status);
    expect(statuses).toContain(429);
  });
});
