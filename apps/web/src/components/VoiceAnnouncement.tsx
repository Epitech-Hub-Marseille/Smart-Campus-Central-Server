import { Play, Radio } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { TemplatePicker } from "@/components/TemplatePicker";
import { emptyTargetState, TargetPicker, toTargets, type TargetState } from "@/components/TargetPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api, apiBlob } from "@/lib/api";
import { languageName, type VoiceCatalogue } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** Language, then voice: the choice of voice depends on the language, so the two selects are linked. */
export function VoicePicker({ catalogue, language, voice, onChange, idPrefix }: { catalogue: VoiceCatalogue; language: string; voice: string; onChange: (next: { language: string; voice: string }) => void; idPrefix: string }) {
  const languages = useMemo(() => [...new Set(catalogue.voices.map((v) => v.language))], [catalogue.voices]);
  const voices = catalogue.voices.filter((v) => v.language === language);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Language" htmlFor={`${idPrefix}-language`}>
        <Select
          id={`${idPrefix}-language`}
          value={language}
          onChange={(e) => onChange({ language: e.target.value, voice: catalogue.voices.find((v) => v.language === e.target.value)!.id })}
        >
          {languages.map((l) => (
            <option key={l} value={l}>
              {languageName(l)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Voice" htmlFor={`${idPrefix}-voice`}>
        <Select id={`${idPrefix}-voice`} value={voice} onChange={(e) => onChange({ language, voice: e.target.value })}>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

/** Type a text, choose a voice, listen to it, then play it on the speakers of the chosen screens. */
export function VoiceAnnouncement({ onSent }: { onSent: () => void }) {
  const voices = useFetch<VoiceCatalogue>("/intercom/voices");
  const [text, setText] = useState("");
  const [choice, setChoice] = useState({ language: "", voice: "" });
  const [targets, setTargets] = useState<TargetState>(emptyTargetState());
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Start on the first voice the engine offers.
  useEffect(() => {
    const first = voices.data?.voices[0];
    if (first && !choice.voice) setChoice({ language: first.language, voice: first.id });
  }, [voices.data, choice.voice]);

  useEffect(() => () => void (clipUrl && URL.revokeObjectURL(clipUrl)), [clipUrl]);

  // A recording made for other words or another voice would be misleading to leave on screen.
  const forget = () => setClipUrl(null);

  if (!voices.data) return null;
  const catalogue = voices.data;

  async function preview() {
    setBusy("preview");
    setError(null);
    try {
      const blob = await apiBlob("/intercom/speech/preview", { text, voice: choice.voice });
      setClipUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate the voice");
    } finally {
      setBusy(null);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const chosen = toTargets(targets);
    if (!chosen) return setError("Choose where to play it");
    setBusy("send");
    setError(null);
    setNotice(null);
    try {
      await api("/intercom/speech", { body: { text, voice: choice.voice, targets: chosen } });
      setNotice("Sent to the speakers.");
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voice announcement</CardTitle>
        <CardDescription>
          {catalogue.enabled
            ? "Type a text, pick a voice, listen to it, then play it on the speakers. The generated sound is kept in the library."
            : "Text-to-speech is not configured on this server. Set TTS_URL to enable it."}
        </CardDescription>
      </CardHeader>
      {catalogue.enabled && (
        <CardContent>
          <form onSubmit={send} className="flex flex-col gap-4">
            <TemplatePicker
              id="v-template"
              kind="voice"
              onPick={(t) => {
                setText(t.text);
                forget();
                const known = catalogue.voices.find((v) => v.id === t.voice);
                if (known) setChoice({ language: known.language, voice: known.id });
              }}
            />
            <Field label="Text to read" htmlFor="v-text" hint={`${text.length} / ${catalogue.maxChars}`}>
              <textarea
                id="v-text"
                required
                rows={3}
                maxLength={catalogue.maxChars}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  forget();
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </Field>
            <VoicePicker
              idPrefix="v"
              catalogue={catalogue}
              language={choice.language}
              voice={choice.voice}
              onChange={(next) => {
                setChoice(next);
                forget();
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={!text.trim() || busy !== null} onClick={() => void preview()}>
                <Play /> {busy === "preview" ? "Generating…" : "Listen first"}
              </Button>
              {clipUrl && <audio controls autoPlay src={clipUrl} className="h-9 max-w-64" aria-label="Pre-listening of the announcement" />}
            </div>
            <TargetPicker value={targets} onChange={setTargets} />
            <ErrorText>{error}</ErrorText>
            {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
            <div>
              <Button type="submit" disabled={!text.trim() || busy !== null}>
                <Radio /> {busy === "send" ? "Sending…" : "Play on the speakers"}
              </Button>
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  );
}
