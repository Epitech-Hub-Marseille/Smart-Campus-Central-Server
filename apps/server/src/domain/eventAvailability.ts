import { CampusEventModel } from "../models/campusEvent.js";

export interface CurrentEvent {
  id: string;
  title: string;
  end: Date;
}

/**
 * The event each of these people is in right now, if any (the one that ends last when several overlap). This is what makes a
 * person show as busy without anyone saying so; what they say themselves wins over it (see `effectiveAvailability`).
 */
export async function currentEventsFor(userIds: string[], now = new Date()): Promise<Map<string, CurrentEvent>> {
  const out = new Map<string, CurrentEvent>();
  if (userIds.length === 0) return out;
  const events = await CampusEventModel.find({ status: "active", allDay: { $ne: true }, start: { $lte: now }, end: { $gt: now }, "people.userId": { $in: userIds } }, { title: 1, end: 1, people: 1 });
  for (const event of events) {
    for (const p of event.people) {
      const id = p.userId ? String(p.userId) : null;
      if (!id || !userIds.includes(id)) continue;
      const known = out.get(id);
      if (!known || event.end > known.end) out.set(id, { id: String(event._id), title: event.title, end: event.end });
    }
  }
  return out;
}
