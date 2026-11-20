import { ulid, ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { HttpError } from "../lib/errors.js";
import { MessageModel } from "../models/message.js";
import { roleOf, UserModel, type Group, type Role } from "../models/user.js";

type AnnouncePriority = (typeof ANNOUNCE_PRIORITIES)[number];

export type Audience = { kind: "everyone" } | { kind: "roles"; roles: Role[] } | { kind: "users"; userIds: string[] };

export interface NewMessage {
  subject: string;
  body: string;
  priority: AnnouncePriority;
  audience: Audience;
  sender?: { id: string; name: string };
}

/** Accounts that can open the console, which is where messages are read. A card-only student or a disabled account cannot. */
async function reachablePeople() {
  return UserModel.find({ disabled: { $ne: true }, email: { $type: "string" } }).select("name groups");
}

/**
 * Sends a message: the recipients are resolved now and stored with it, so "who has read it" stays answerable and a person who
 * joins later does not find an old notice in their inbox. The sender is never their own recipient.
 */
export async function sendMessage(input: NewMessage) {
  const people = await reachablePeople();
  const { audience } = input;
  const chosen = people.filter((p) => {
    if (p.id === input.sender?.id) return false;
    if (audience.kind === "everyone") return true;
    if (audience.kind === "roles") return audience.roles.includes(roleOf(p.groups as Group[]));
    return audience.userIds.includes(p.id);
  });
  if (chosen.length === 0) throw new HttpError(400, "Nobody can receive this message: the audience is empty or has no account that can sign in");

  return MessageModel.create({
    messageId: ulid(),
    subject: input.subject,
    body: input.body,
    priority: input.priority,
    senderId: input.sender?.id,
    senderName: input.sender?.name ?? "Smart Campus",
    audience: {
      kind: audience.kind,
      roles: audience.kind === "roles" ? audience.roles : [],
      userIds: audience.kind === "users" ? audience.userIds : [],
    },
    recipients: chosen.map((p) => ({ userId: p.id, name: p.name })),
  });
}

/** For the system itself (an alert): never throws, because a missing recipient must not break what raised the alert. */
export async function notifyManagers(subject: string, body: string, priority: AnnouncePriority): Promise<void> {
  try {
    await sendMessage({ subject, body, priority, audience: { kind: "roles", roles: ["admin", "operator"] } });
  } catch (err) {
    console.error("system message failed", err instanceof Error ? err.message : err);
  }
}

export const unreadCount = (userId: string) =>
  MessageModel.countDocuments({ recipients: { $elemMatch: { userId, readAt: { $exists: false } } } });

/** Marks one message (or all) as read by this person. Idempotent: the first reading time is kept. */
export async function markRead(userId: string, messageId?: string): Promise<number> {
  const result = await MessageModel.updateMany(
    { ...(messageId && { messageId }), recipients: { $elemMatch: { userId, readAt: { $exists: false } } } },
    { $set: { "recipients.$[me].readAt": new Date() } },
    { arrayFilters: [{ "me.userId": userId, "me.readAt": { $exists: false } }] },
  );
  return result.modifiedCount;
}
