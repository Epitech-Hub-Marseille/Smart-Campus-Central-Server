import { createHash } from "node:crypto";
import { ulid } from "@smartcampus/protocol";
import { deleteFile, saveFile } from "../infra/gridfs.js";
import { HttpError } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import { sniffAudio } from "../lib/audioSniff.js";
import { sniffMedia } from "../lib/mediaSniff.js";
import { AssetModel } from "../models/asset.js";
import { isAssetInUse } from "./content.js";
import { CommandModel } from "../models/command.js";
import type { PublicUser } from "../models/user.js";

type Actor = Pick<PublicUser, "id" | "name">;

/** Validates an uploaded audio file, stores it in GridFS and records its hash and size. */
export async function storeAudioAsset(data: Buffer, name: string, actor: Actor) {
  if (data.length === 0) throw new HttpError(400, "The file is empty");
  const format = sniffAudio(data);
  if (!format) throw new HttpError(415, "Unsupported audio file. Use WAV, MP3, Ogg, WebM or M4A");

  const assetId = ulid();
  const sha256 = createHash("sha256").update(data).digest("hex");
  const gridFsId = await saveFile(`${assetId}.${format.extension}`, data);
  const asset = await AssetModel.create({
    assetId,
    name,
    mime: format.mime,
    extension: format.extension,
    size: data.length,
    sha256,
    gridFsId,
    createdByName: actor.name,
  });
  await recordAudit(actor, "asset.upload", { type: "asset", id: assetId }, { name, size: data.length });
  return asset;
}

/** Same as `storeAudioAsset` for the content library: an image or a video, judged by its bytes. */
export async function storeMediaAsset(data: Buffer, name: string, actor: Actor) {
  if (data.length === 0) throw new HttpError(400, "The file is empty");
  const format = sniffMedia(data);
  if (!format) throw new HttpError(415, "Unsupported file. Use PNG, JPEG, WebP, GIF, MP4 or WebM");

  const assetId = ulid();
  const sha256 = createHash("sha256").update(data).digest("hex");
  const gridFsId = await saveFile(`${assetId}.${format.extension}`, data);
  const asset = await AssetModel.create({
    assetId,
    name,
    kind: format.kind,
    mime: format.mime,
    extension: format.extension,
    size: data.length,
    sha256,
    gridFsId,
    createdByName: actor.name,
  });
  await recordAudit(actor, "asset.upload", { type: "asset", id: assetId }, { name, kind: format.kind, size: data.length });
  return asset;
}

/** The reference a device receives for an asset, taken from the stored record: a client never gets to state a hash or a size. */
export const assetRefOf = (a: { assetId: string; sha256: string; size: number; mime: string }) => ({
  assetId: a.assetId,
  sha256: a.sha256,
  size: a.size,
  mime: a.mime,
});

export async function deleteAsset(assetId: string, actor: Actor): Promise<void> {
  if (await isAssetInUse(assetId)) throw new HttpError(409, "This file is used by a slide or a screen logo. Remove it there first");
  const asset = await AssetModel.findOneAndDelete({ assetId });
  if (!asset) throw new HttpError(404, "Asset not found");
  await deleteFile(asset.gridFsId);
  await recordAudit(actor, "asset.delete", { type: "asset", id: assetId }, { name: asset.name });
}

/**
 * Least privilege for downloads: a device may only fetch an asset it was told to play or show. Without this,
 * any enrolled device could read every recording stored on the server.
 */
export const wasAssetSentTo = (deviceId: string, assetId: string) =>
  CommandModel.exists({
    deviceId,
    $or: [
      { type: "audio.play", "payload.assetId": assetId },
      // A Faculty screen downloads what its playlist or its logo names, and nothing else.
      { type: "content.set", "payload.items.asset.assetId": assetId },
      { type: "faculty.config.set", "payload.config.site.logo.assetId": assetId },
    ],
  });
