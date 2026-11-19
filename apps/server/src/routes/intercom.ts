import { rateLimit } from "express-rate-limit";
import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../auth/middleware.js";
import { broadcastAudio, emergencyVoiceId, MAX_SPEECH_CHARS, previewSpeech, speak } from "../domain/intercom.js";
import { CHIME_IDS, chimeCatalogue, chimeWav } from "../lib/chimes.js";
import { targetsInput } from "../domain/targeting.js";
import { ttsEngine } from "../infra/tts.js";

/** InterCom: play a stored sound or a generated voice on chosen devices. Admins and operators only. */
export const intercomRouter = Router();
intercomRouter.use(requireRole("admin", "operator"));

intercomRouter.post("/broadcasts", async (req, res) => {
  const input = z
    .object({ assetId: z.string().min(1).max(40), title: z.string().trim().max(200).optional(), targets: targetsInput })
    .parse(req.body);
  const broadcast = await broadcastAudio(input, req.user!);
  res.status(201).json({ id: broadcast.announcementId, deviceCount: broadcast.deviceIds.length });
});

const speechInput = z.object({
  text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
  voice: z.string().min(1).max(60).optional(),
  chime: z.enum(CHIME_IDS).optional(),
});

// Each synthesis costs money or CPU on the engine, so it is limited per person, not per address.
const synthesisLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
  message: { error: "Too many voice requests, try again in a minute" },
});

/** What the console may offer: false when no engine is configured. */
intercomRouter.get("/voices", (_req, res) => {
  const engine = ttsEngine();
  res.json({ enabled: Boolean(engine), maxChars: MAX_SPEECH_CHARS, voices: engine?.voices() ?? [], emergencyVoice: emergencyVoiceId() ?? engine?.voices()[0]?.id ?? null });
});

/** The chimes the console offers, by group. */
intercomRouter.get("/chimes", (_req, res) => {
  res.json(chimeCatalogue());
});

/** Pre-listening to a chime on its own. */
intercomRouter.get("/chimes/:id", (req, res) => {
  const id = z.enum(CHIME_IDS).parse(req.params.id);
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(chimeWav(id));
});

/** Pre-listening: audio for the text, nothing stored and nothing sent to a screen. */
intercomRouter.post("/speech/preview", synthesisLimiter, async (req, res) => {
  const { data, mime } = await previewSpeech(speechInput.parse(req.body));
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store");
  res.send(data);
});

/** Generates the voice and plays it on the chosen screens. */
intercomRouter.post("/speech", synthesisLimiter, async (req, res) => {
  const input = speechInput.extend({ title: z.string().trim().max(100).optional(), targets: targetsInput }).parse(req.body);
  const broadcast = await speak(input, req.user!);
  res.status(201).json({ id: broadcast.announcementId, deviceCount: broadcast.deviceIds.length });
});
