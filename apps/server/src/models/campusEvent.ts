import { Schema, model } from "mongoose";

/** One event read from a portal. A cancelled one stays as history until it is out of the window. */
const personSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String },
    role: { type: String, enum: ["organizer", "attendee"], required: true },
    // The account it was matched to or registered as; absent when the event only gives a name.
    userId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false },
);

const campusEventSchema = new Schema(
  {
    integration: { type: Schema.Types.ObjectId, ref: "Integration", required: true },
    externalId: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    category: { type: String, default: "" },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    allDay: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "cancelled"], default: "active", required: true },
    // As the portal wrote them, and the rooms they were matched to.
    locations: { type: [String], default: [] },
    rooms: { type: [{ type: Schema.Types.ObjectId, ref: "Room" }], default: [] },
    people: { type: [personSchema], default: [] },
    // Of what the portal said, to tell a changed event from an unchanged one without comparing field by field.
    contentHash: { type: String, required: true },
  },
  { timestamps: true },
);

campusEventSchema.index({ integration: 1, externalId: 1 }, { unique: true });
campusEventSchema.index({ status: 1, start: 1, end: 1 });
campusEventSchema.index({ "people.userId": 1, status: 1 });

export const CampusEventModel = model("CampusEvent", campusEventSchema);

export interface CampusEventLike {
  _id: unknown;
  integration: unknown;
  externalId: string;
  title: string;
  description?: string | null;
  category?: string | null;
  start: Date;
  end: Date;
  allDay?: boolean | null;
  status: string;
  locations: string[];
  rooms: unknown[];
  people: { name: string; email?: string | null; role: string; userId?: unknown }[];
}

export const campusEventDto = (e: CampusEventLike) => ({
  id: String(e._id),
  integrationId: String(e.integration),
  externalId: e.externalId,
  title: e.title,
  description: e.description ?? "",
  category: e.category ?? "",
  start: e.start,
  end: e.end,
  allDay: Boolean(e.allDay),
  status: e.status,
  locations: e.locations,
  roomIds: e.rooms.map(String),
  people: e.people.map((p) => ({ name: p.name, email: p.email ?? null, role: p.role, userId: p.userId ? String(p.userId) : null })),
});
