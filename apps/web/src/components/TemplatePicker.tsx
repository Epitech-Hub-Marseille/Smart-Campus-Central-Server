import { Field } from "@/components/Field";
import { Select } from "@/components/ui/select";
import type { AnnouncementTemplate } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/**
 * Fills a form from the template library. It only copies: editing the form afterwards does not change the
 * template. Renders nothing when the library is empty, so the form is not cluttered.
 */
export function TemplatePicker({ id, kind, onPick }: { id: string; kind?: AnnouncementTemplate["kind"]; onPick: (template: AnnouncementTemplate) => void }) {
  const { data } = useFetch<{ items: AnnouncementTemplate[] }>("/announcement-templates");
  const items = (data?.items ?? []).filter((t) => !kind || t.kind === kind);
  if (items.length === 0) return null;

  return (
    <Field label="Start from a template" htmlFor={id}>
      <Select
        id={id}
        value=""
        onChange={(e) => {
          const picked = items.find((t) => t.id === e.target.value);
          if (picked) onPick(picked);
        }}
      >
        <option value="">Choose a template…</option>
        {items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
