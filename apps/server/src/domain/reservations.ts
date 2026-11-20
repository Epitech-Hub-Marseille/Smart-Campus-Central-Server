import { ulid, type PayloadOf } from "@smartcampus/protocol";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { config } from "../config.js";
import { DeviceModel } from "../models/device.js";
import { ReservationModel } from "../models/reservation.js";
import { RoomModel } from "../models/room.js";
import type { PublicUser } from "../models/user.js";
import { enqueueCommand } from "./commands.js";
import { notifyFacultyChanged } from "./faculty.js";

type Actor = Pick<PublicUser, "id" | "name" | "role">;

/** A booking is for a meeting or a class, not a standing block. */
export const MAX_RESERVATION_MS = 12 * 3_600_000;
/** Forgives a few minutes: someone booking "now" must not be refused because the form took a minute to fill. */
const PAST_TOLERANCE_MS = 5 * 60_000;
/** How far ahead rooms can be booked. */
export const MAX_ADVANCE_DAYS = 366;
/** A door screen is sent this many hours of upcoming reservations. */
const DOOR_WINDOW_MS = 48 * 3_600_000;
const DOOR_ITEMS = 5;

export interface ReservationInput {
  roomId: string;
  title: string;
  start: Date;
  end: Date;
}

const overlapping = (roomId: unknown, start: Date, end: Date) => ({ room: roomId, status: "active", start: { $lt: end }, end: { $gt: start } });

const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: config.CAMPUS_TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/** "Exam" 10:00-12:00, so the message says what to move rather than just "conflict". */
const describe = (r: { title: string; start: Date; end: Date }) => `"${r.title}" ${hhmm(r.start)}-${hhmm(r.end)}`;

/**
 * Books a room. Two people clicking at the same moment must not both win, and MongoDB has no
 * cross-document constraint for "no overlap", so the booking is inserted first and the check runs
 * after: of two overlapping bookings only the one inserted later (greater id) backs out.
 */
export async function createReservation(input: ReservationInput, actor: Actor) {
  const now = Date.now();
  if (input.end.getTime() <= input.start.getTime()) throw new HttpError(400, "end must be after start");
  if (input.end.getTime() - input.start.getTime() > MAX_RESERVATION_MS) throw new HttpError(400, "A reservation lasts at most 12 hours");
  if (input.start.getTime() < now - PAST_TOLERANCE_MS) throw new HttpError(400, "start is in the past");
  if (input.start.getTime() > now + MAX_ADVANCE_DAYS * 86_400_000) throw new HttpError(400, "start is too far ahead");

  const room = await RoomModel.findById(input.roomId);
  if (!room) throw new HttpError(404, "Room not found");

  const before = await ReservationModel.find(overlapping(room._id, input.start, input.end)).sort({ start: 1 }).limit(3);
  if (before.length) throw new HttpError(409, `The room is already booked: ${before.map(describe).join(", ")}`);

  const reservation = await ReservationModel.create({
    reservationId: ulid(),
    room: room._id,
    title: input.title,
    start: input.start,
    end: input.end,
    organizerId: actor.id,
    organizerName: actor.name,
  });

  const earlier = await ReservationModel.find({ ...overlapping(room._id, input.start, input.end), _id: { $lt: reservation._id } }).limit(3);
  if (earlier.length) {
    await reservation.deleteOne();
    throw new HttpError(409, `The room is already booked: ${earlier.map(describe).join(", ")}`);
  }

  await recordAudit(actor, "reservation.create", { type: "reservation", id: reservation.reservationId }, { room: room.code });
  await syncReservations(String(room._id));
  return reservation;
}

/** The organiser, an admin or an operator may cancel. */
export async function cancelReservation(reservationId: string, actor: Actor) {
  const reservation = await ReservationModel.findOne({ reservationId, status: "active" });
  if (!reservation) throw new HttpError(404, "Reservation not found");
  if (reservation.organizerId !== actor.id && actor.role === "staff") throw new HttpError(403, "Only the organiser can cancel this reservation");

  reservation.status = "cancelled";
  reservation.cancelledByName = actor.name;
  await reservation.save();
  await recordAudit(actor, "reservation.cancel", { type: "reservation", id: reservationId }, {});
  await syncReservations(String(reservation.room));
  return reservation;
}

/** Upcoming reservations of one room, as a door screen receives them: the current and the next ones. */
export async function doorReservations(roomId: string, now = new Date()) {
  const items = await ReservationModel.find({
    room: roomId,
    status: "active",
    end: { $gt: now },
    start: { $lt: new Date(now.getTime() + DOOR_WINDOW_MS) },
  })
    .sort({ start: 1 })
    .limit(DOOR_ITEMS);
  return items.map((r) => ({
    id: r.reservationId,
    title: r.title.slice(0, 100),
    start: r.start.getTime(),
    end: r.end.getTime(),
    organizer: r.organizerName.slice(0, 60),
  })) satisfies PayloadOf<"reservations.set">["items"];
}

/** Sends a room's reservations to its door screens. A failure is logged: the booking itself is already saved. */
export async function pushReservationsToDevice(deviceId: string, roomId: string): Promise<void> {
  await enqueueCommand(deviceId, "reservations.set", { roomId, items: await doorReservations(roomId) });
}

export async function syncReservations(roomId: string): Promise<void> {
  try {
    for (const device of await DeviceModel.find({ room: roomId, status: "active", type: "door" }, { deviceId: 1 })) {
      await pushReservationsToDevice(device.deviceId, roomId);
    }
  } catch (err) {
    console.error("reservation push failed", err instanceof Error ? err.message : err);
  }
  await notifyFacultyChanged();
}

/** Periodic refresh: past reservations leave the list and the next one moves up even if nobody booked anything. */
export async function refreshAllDoorReservations(): Promise<void> {
  for (const device of await DeviceModel.find({ type: "door", status: "active", room: { $exists: true, $ne: null } }, { deviceId: 1, room: 1 })) {
    await pushReservationsToDevice(device.deviceId, String(device.room));
  }
}
