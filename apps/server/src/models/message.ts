import { ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { Schema, model } from "mongoose";

/** Who a message was addressed to when it was sent. `roles` are console roles, not groups. */
const audienceSchema = new Schema(
  {
    kind: { type: String, enum: ["everyone", "roles", "users"], required: true },
    roles: { type: [String], default: [] },
    userIds: { type: [String], default: [] },
  },
  { _id: false },
);

/** One recipient and whether they opened the message. The list is fixed at send time: later arrivals do not receive it. */
const recipientSchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    readAt: { type: Date },
  },
  { _id: false },
);

/**
 * An internal message to people of the campus (staff notice, a heads-up, a system alert such as a device that went offline).
 * `senderId` is absent for a message the system sent itself.
 */
const messageSchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true },
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    priority: { type: String, enum: ANNOUNCE_PRIORITIES, default: "info", required: true },
    senderId: { type: String },
    senderName: { type: String, required: true },
    audience: { type: audienceSchema, required: true },
    recipients: { type: [recipientSchema], default: [] },
  },
  { timestamps: true },
);

messageSchema.index({ createdAt: -1 });
// "My messages" and "my unread messages" both look a person up inside the recipients.
messageSchema.index({ "recipients.userId": 1, createdAt: -1 });

export const MessageModel = model("Message", messageSchema);
type MessageDoc = InstanceType<typeof MessageModel>;

export const messageDto = (m: MessageDoc, userId?: string) => {
  const mine = userId ? m.recipients.find((r) => r.userId === userId) : undefined;
  return {
    id: m.messageId,
    subject: m.subject,
    body: m.body,
    priority: m.priority,
    sender: m.senderName,
    sentAt: m.createdAt,
    readAt: mine?.readAt ?? null,
  };
};

/** What the sender sees: the same, plus who got it and who opened it. */
export const sentMessageDto = (m: MessageDoc, withRecipients = false) => ({
  ...messageDto(m),
  audience: { kind: m.audience.kind, roles: m.audience.roles, count: m.audience.userIds.length },
  recipientCount: m.recipients.length,
  readCount: m.recipients.filter((r) => r.readAt).length,
  ...(withRecipients && { recipients: m.recipients.map((r) => ({ userId: r.userId, name: r.name, readAt: r.readAt ?? null })) }),
});
