import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

export interface Voice {
  id: string;
  label: string;
  /** Language the voice speaks, as a short code ("fr", "en"). */
  language: string;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  language: string;
  /** 1 is the voice's natural pace. Left out for ordinary speech. */
  speed?: number;
  /** Asked when the audio must be edited afterwards (a chime in front): WAV can be joined without a decoder. Default mp3. */
  format?: "mp3" | "wav";
}

/**
 * The text-to-speech engine behind an interface (open decision: the vendor is not chosen). The rest of
 * the server only knows this; swapping the engine means writing another implementation.
 */
export interface TtsEngine {
  voices(): Voice[];
  /** Returns an audio file (the format is checked by the caller). */
  synthesize(request: SpeechRequest): Promise<Buffer>;
}

/** Parses `id|label|language,id|label|language`. A malformed entry is a configuration error, not a silent skip. */
export function parseVoices(raw: string): Voice[] {
  const voices = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label, language] = entry.split("|").map((part) => part?.trim());
      if (!id || !label || !language) throw new Error(`TTS_VOICES: "${entry}" is not id|label|language`);
      return { id, label, language: language.toLowerCase() };
    });
  if (voices.length === 0) throw new Error("TTS_VOICES must list at least one voice");
  return voices;
}

/** Any server that implements the OpenAI `POST /audio/speech` API (hosted, or self-hosted such as a Piper wrapper). */
export class OpenAiCompatibleTts implements TtsEngine {
  constructor(
    private readonly options: { baseUrl: string; apiKey?: string; model: string; timeoutMs: number; maxBytes: number; voices: Voice[] },
  ) {}

  voices() {
    return this.options.voices;
  }

  async synthesize({ text, voice, language, speed, format }: SpeechRequest): Promise<Buffer> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/audio/speech`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey && { authorization: `Bearer ${this.options.apiKey}` }) },
        // `language` is ignored by engines that detect it from the text and honoured by those that need it.
        body: JSON.stringify({ model: this.options.model, input: text, voice, language, response_format: format ?? "mp3", ...(speed !== undefined && { speed }) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      // Why: the cause can contain the URL; the console only needs to know the engine did not answer.
      throw new HttpError(502, "The text-to-speech engine did not answer");
    }
    if (!res.ok) throw new HttpError(502, `The text-to-speech engine refused the request (${res.status})`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > this.options.maxBytes) throw new HttpError(502, "The generated audio is too large");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > this.options.maxBytes) throw new HttpError(502, "The generated audio is too large");
    return data;
  }
}

let override: TtsEngine | null | undefined;

/** Tests inject a fake engine; `null` forces "not configured". */
export function setTtsEngine(engine: TtsEngine | null | undefined): void {
  override = engine;
}

export function ttsEngine(): TtsEngine | null {
  if (override !== undefined) return override;
  if (!config.TTS_URL) return null;
  return new OpenAiCompatibleTts({
    baseUrl: config.TTS_URL,
    apiKey: config.TTS_API_KEY,
    model: config.TTS_MODEL,
    timeoutMs: config.TTS_TIMEOUT_MS,
    maxBytes: config.MAX_AUDIO_MB * 1024 * 1024,
    voices: parseVoices(config.TTS_VOICES),
  });
}

/** The engine, or a 501 the console can explain. */
export function requireTts(): TtsEngine {
  const engine = ttsEngine();
  if (!engine) throw new HttpError(501, "Text-to-speech is not configured on this server");
  return engine;
}
