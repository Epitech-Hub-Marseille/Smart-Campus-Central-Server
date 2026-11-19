import { verifyRequest } from "@smartcampus/handshake";
import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { config } from "../config.js";
import { deleteAsset, normalizeFolder, replaceMediaAsset, storeAudioAsset, storeMediaAsset, updateMediaAsset, wasAssetSentTo } from "../domain/assets.js";
import { assetUsage } from "../domain/screens.js";
import { activePublicKey } from "../domain/devices.js";
import { openFile } from "../infra/gridfs.js";
import { HttpError } from "../lib/errors.js";
import { AssetModel, assetDto } from "../models/asset.js";

export const assetsRouter = Router();

/** The console uploads with a raw body; the real check is the content sniffing in storeAudioAsset. */
const rawUpload = express.raw({ type: () => true, limit: `${config.MAX_AUDIO_MB}mb` });

/** Images and videos are bigger than sounds, so they have their own limit. */
const rawMedia = express.raw({ type: () => true, limit: `${config.MAX_MEDIA_MB}mb` });

const downloadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many downloads, try again later" },
});

const sendAsset = async (asset: InstanceType<typeof AssetModel>, res: express.Response) => {
  res.setHeader("Content-Type", asset.mime);
  res.setHeader("Content-Length", String(asset.size));
  res.setHeader("X-Content-SHA256", asset.sha256);
  // The id is a ULID and the content never changes, so devices and browsers may keep it.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Content-Disposition", `inline; filename="${asset.assetId}.${asset.extension}"`);
  openFile(asset.gridFsId).on("error", () => res.destroy()).pipe(res);
};

/**
 * Device download. The request is signed with the device key (method, path, timestamp), so a
 * stolen URL is useless. Every failure answers the same 401/404 to reveal nothing.
 */
assetsRouter.get("/:id/download", downloadLimiter, async (req, res) => {
  const deviceId = req.get("x-device-id") ?? "";
  const publicKey = deviceId ? await activePublicKey(deviceId) : null;
  const path = req.originalUrl.split("?")[0]!;
  const signed = publicKey
    ? verifyRequest(publicKey, {
        method: req.method,
        path,
        timestamp: req.get("x-timestamp") ?? "",
        signature: req.get("x-signature") ?? "",
      })
    : false;
  if (!signed) throw new HttpError(401, "Unauthorized");

  const asset = await AssetModel.findOne({ assetId: req.params.id });
  if (!asset || !(await wasAssetSentTo(deviceId, asset.assetId))) throw new HttpError(404, "Not found");
  await sendAsset(asset, res);
});

/** Console: everything below needs a signed-in user. */
assetsRouter.use(requireAuth);

const canWrite = requireRole("admin", "operator");

assetsRouter.get("/", async (req, res) => {
  // Without a kind, the sound library, as before: a screen that lists sounds must not suddenly list videos.
  // "media" is the content library: images and videos together.
  const kind = z.enum(["audio", "image", "video", "media"]).default("audio").parse(req.query.kind);
  const filter = kind === "audio" ? { $or: [{ kind: "audio" }, { kind: { $exists: false } }] } : kind === "media" ? { kind: { $in: ["image", "video"] } } : { kind };
  const items = await AssetModel.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json({ items: items.map(assetDto), folders: [...new Set(items.map((a) => a.folder).filter(Boolean))].sort() });
});

/** Upload to the content library. The kind (image or video) is decided from the file itself. */
assetsRouter.post("/media", canWrite, rawMedia, async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 100) : "";
  if (!name) throw new HttpError(400, "name is required");
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the file as the request body");
  res.status(201).json(assetDto(await storeMediaAsset(req.body, name, req.user!, normalizeFolder(req.query.folder))));
});

const renameInput = z.object({ name: z.string().trim().min(1).max(100).optional(), folder: z.string().max(40).optional() }).strict();

/** Rename a file or move it to another folder. */
assetsRouter.patch("/:id", canWrite, async (req, res) => {
  const input = renameInput.parse(req.body);
  res.json(assetDto(await updateMediaAsset(String(req.params.id), { ...(input.name && { name: input.name }), ...(input.folder !== undefined && { folder: normalizeFolder(input.folder) }) }, req.user!)));
});

/** Replace the content of an image or a video; screens that show it get the new version. */
assetsRouter.put("/:id/file", canWrite, rawMedia, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the file as the request body");
  res.json(assetDto(await replaceMediaAsset(String(req.params.id), req.body, req.user!)));
});

/** Which screens, groups or the default show this file. */
assetsRouter.get("/:id/usage", async (req, res) => {
  res.json({ items: await assetUsage(String(req.params.id)) });
});

assetsRouter.post("/", canWrite, rawUpload, async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim().slice(0, 100) : "";
  if (!name) throw new HttpError(400, "name is required");
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the audio file as the request body");
  const asset = await storeAudioAsset(req.body, name, req.user!);
  res.status(201).json(assetDto(asset));
});

/** Preview in the console, with the user's session. */
assetsRouter.get("/:id/file", async (req, res) => {
  const asset = await AssetModel.findOne({ assetId: req.params.id });
  if (!asset) throw new HttpError(404, "Asset not found");
  await sendAsset(asset, res);
});

assetsRouter.delete("/:id", canWrite, async (req, res) => {
  await deleteAsset(String(req.params.id), req.user!);
  res.status(204).end();
});
