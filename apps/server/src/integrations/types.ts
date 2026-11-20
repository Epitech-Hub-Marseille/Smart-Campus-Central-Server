/**
 * The contract of a portal plugin. A plugin knows one kind of ENT, student portal or campus administration system and does one
 * thing: ask it for the events of a time window and give them back in the shape below. Everything that follows (matching
 * rooms and people, reservations, busy status, scheduling, the console) is the same for every plugin and lives in
 * `domain/integrations.ts`, so a new portal is one file here and one line in `registry.ts`.
 */

/** Someone an event names. `email` is what links them to an account; without it only an exact name can. */
export interface PortalPerson {
  name: string;
  email: string | null;
  role: "organizer" | "attendee";
}

export interface PortalEvent {
  /** Stable id of the event in the portal: the same event keeps it when its time or room changes. */
  externalId: string;
  title: string;
  description: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** The portal says it is cancelled. An event that simply disappears from the portal is treated the same way. */
  cancelled: boolean;
  /** Where it takes place, as the portal writes it ("Pédagogie 1-8"): matched to a room by name or code. */
  locations: string[];
  people: PortalPerson[];
  /** A short label to group by, such as a module or course code. */
  category: string;
}

export interface FetchWindow {
  from: Date;
  to: Date;
}

/** What a plugin may use: the network and the campus time zone, passed in so tests need neither. */
export interface PluginContext {
  fetch: typeof fetch;
  timezone: string;
}

/** A setting of a plugin, described so the console can draw its form without knowing the plugin. */
export interface PluginField {
  key: string;
  label: string;
  type: "url" | "text" | "number" | "boolean";
  /** Kept encrypted, never sent back to the console: it may be a token in a URL or a password. */
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface PortalPlugin<Config = Record<string, unknown>> {
  id: string;
  label: string;
  description: string;
  fields: PluginField[];
  /** Validates and normalises the settings; throws a ZodError (answered 400) when they are wrong. */
  parseConfig(raw: unknown): Config;
  fetchEvents(config: Config, window: FetchWindow, context: PluginContext): Promise<PortalEvent[]>;
}

/** A plugin that cannot reach or read its portal says so with this: the message is shown in the console, so it never holds a secret. */
export class PortalError extends Error {}
