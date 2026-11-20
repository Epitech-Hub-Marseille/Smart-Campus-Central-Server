import { Schema, model, type Types } from "mongoose";

/** A room booked for a time slot. A cancelled one stays as history and no longer blocks the slot. */
const reservationSchema = new Schema(
  {
    reservationId: { type: String, required: true, unique: true },
    room: { type: Schema.Types.ObjectId, ref: "Room", required: true },
    title: { type: String, required: true, trim: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    organizerId: { type: String, required: true },
    organizerName: { type: String, required: true },
    status: { type: String, enum: ["active", "cancelled"], default: "active", required: true },
    cancelledByName: { type: String },
    // Set for a reservation that mirrors an event of a portal (see domain/integrations.ts): the portal is the truth, so it is
    // kept in step with it and is not subject to the conflict check of a booking.
    source: { type: String },
    externalKey: { type: String },
  },
  { timestamps: true },
);

// The conflict check and the "next reservation of this room" query both read by room and start.
reservationSchema.index({ room: 1, status: 1, start: 1 });
reservationSchema.index({ start: 1, status: 1 });
reservationSchema.index({ externalKey: 1 }, { unique: true, partialFilterExpression: { externalKey: { $type: "string" } } });

export const ReservationModel = model("Reservation", reservationSchema);

export interface ReservationLike {
  reservationId: string;
  room: Types.ObjectId | { _id: Types.ObjectId; code: string; name?: string | null; building?: { name: string; code: string } | null };
  title: string;
  start: Date;
  end: Date;
  organizerId: string;
  organizerName: string;
  status: string;
}

export const reservationDto = (r: ReservationLike) => {
  const populated = "code" in r.room ? r.room : null;
  return {
    id: r.reservationId,
    roomId: String("_id" in r.room ? r.room._id : r.room),
    room: populated ? { code: populated.code, name: populated.name ?? "", building: populated.building?.name ?? "" } : null,
    title: r.title,
    start: r.start,
    end: r.end,
    organizerId: r.organizerId,
    organizer: r.organizerName,
    status: r.status,
  };
};
