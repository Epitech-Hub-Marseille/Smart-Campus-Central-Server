import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { cancelReservation, createReservation } from "../domain/reservations.js";
import { objectId, pagination } from "../lib/http.js";
import { ReservationModel, reservationDto } from "../models/reservation.js";

/**
 * Room reservations. Anyone signed in may book and cancel their own; admins and operators cancel any.
 * (A deliberate difference from campus data, which staff only read: booking a room is a daily task.)
 */
export const reservationsRouter = Router();
reservationsRouter.use(requireAuth);

const input = z.object({
  // An id that is not even well formed is just "not found", like everywhere else.
  roomId: z.string().min(1).max(40).transform((id) => objectId(id)),
  title: z.string().trim().min(1).max(100),
  start: z.coerce.date(),
  end: z.coerce.date(),
});

const listQuery = pagination.extend({
  room: z.string().min(1).max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  mine: z.enum(["true", "false"]).optional(),
  status: z.enum(["active", "cancelled"]).default("active"),
});

reservationsRouter.get("/", async (req, res) => {
  const q = listQuery.parse(req.query);
  const filter: Record<string, unknown> = { status: q.status };
  if (q.room) filter.room = objectId(q.room);
  if (q.mine === "true") filter.organizerId = req.user!.id;
  // Reservations that overlap [from, to): one that started yesterday and ends tomorrow shows up today.
  if (q.from) filter.end = { $gt: q.from };
  if (q.to) filter.start = { $lt: q.to };
  const [items, total] = await Promise.all([
    ReservationModel.find(filter)
      .sort({ start: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate({ path: "room", select: "code name building", populate: { path: "building", select: "name code" } }),
    ReservationModel.countDocuments(filter),
  ]);
  res.json({ items: items.map((r) => reservationDto(r as never)), total, page: q.page, limit: q.limit });
});

reservationsRouter.post("/", async (req, res) => {
  const reservation = await createReservation(input.parse(req.body), req.user!);
  res.status(201).json(reservationDto(reservation));
});

reservationsRouter.delete("/:id", async (req, res) => {
  await cancelReservation(String(req.params.id), req.user!);
  res.status(204).end();
});
