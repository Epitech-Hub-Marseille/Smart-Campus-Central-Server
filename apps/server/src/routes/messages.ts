import { ANNOUNCE_PRIORITIES } from "@smartcampus/protocol";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { markRead, sendMessage, unreadCount } from "../domain/messages.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { MessageModel, messageDto, sentMessageDto } from "../models/message.js";
import { ROLES } from "../models/user.js";

/**
 * Internal messages. Everybody with an account reads their own inbox; only administrators and operators write and see who
 * has read what (the read receipts).
 */
export const messagesRouter = Router();
messagesRouter.use(requireAuth);

const sendInput = z.object({
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  priority: z.enum(ANNOUNCE_PRIORITIES).default("info"),
  audience: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("everyone") }),
    z.object({ kind: z.literal("roles"), roles: z.array(z.enum(ROLES)).min(1) }),
    z.object({ kind: z.literal("users"), userIds: z.array(z.string().min(1).max(64)).min(1).max(500) }),
  ]),
});

const listQuery = z.object({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  page: z.coerce.number().int().min(1).default(1),
});

messagesRouter.get("/inbox", async (req, res) => {
  const { unread, limit, page } = listQuery.parse(req.query);
  const me = req.user!.id;
  const filter = { recipients: { $elemMatch: { userId: me, ...(unread === "true" && { readAt: { $exists: false } }) } } };
  const [items, total, unreadTotal] = await Promise.all([
    MessageModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    MessageModel.countDocuments(filter),
    unreadCount(me),
  ]);
  res.json({ items: items.map((m) => messageDto(m, me)), total, unread: unreadTotal });
});

messagesRouter.get("/unread-count", async (req, res) => {
  res.json({ unread: await unreadCount(req.user!.id) });
});

messagesRouter.post("/read-all", async (req, res) => {
  res.json({ marked: await markRead(req.user!.id) });
});

messagesRouter.post("/:id/read", async (req, res) => {
  const id = String(req.params.id);
  const message = await MessageModel.findOne({ messageId: id, "recipients.userId": req.user!.id }).select("_id");
  // A message that is not yours is the same as one that does not exist.
  if (!message) throw new HttpError(404, "Message not found");
  await markRead(req.user!.id, id);
  res.status(204).end();
});

// Everything below is for the people who write messages.
const managers = requireRole("admin", "operator");

messagesRouter.get("/sent", managers, async (req, res) => {
  const { limit, page } = listQuery.parse(req.query);
  const [items, total] = await Promise.all([
    MessageModel.find({ senderId: req.user!.id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    MessageModel.countDocuments({ senderId: req.user!.id }),
  ]);
  res.json({ items: items.map((m) => sentMessageDto(m)), total });
});

messagesRouter.get("/sent/:id", managers, async (req, res) => {
  const message = await MessageModel.findOne({ messageId: String(req.params.id) });
  // Messages written by someone else (or by the system) are visible to administrators only: they hold other people's reading.
  if (!message || (message.senderId !== req.user!.id && req.user!.role !== "admin")) throw new HttpError(404, "Message not found");
  res.json(sentMessageDto(message, true));
});

messagesRouter.post("/", managers, async (req, res) => {
  const input = sendInput.parse(req.body);
  const message = await sendMessage({ ...input, sender: { id: req.user!.id, name: req.user!.name } });
  await recordAudit(req.user!, "message.send", { type: "message", id: message.messageId }, { subject: message.subject, recipients: message.recipients.length });
  res.status(201).json(sentMessageDto(message));
});
