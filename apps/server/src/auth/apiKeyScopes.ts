/**
 * What an API key may do, and the only endpoints it may reach.
 *
 * Deny by default: a request made with a key is checked against `RULES`, and an endpoint that is not listed is refused
 * whatever the key's scopes are. New endpoints are therefore closed to keys until someone decides here that they belong
 * to a scope. Never listed, on purpose: accounts and sign-in, API keys themselves, device enrollment and commands, and
 * emergency alerts (a machine cannot hold the second factor those need).
 */
export interface ScopeDef {
  id: string;
  label: string;
  description: string;
  group: "Campus" | "Communication" | "Faculty screens" | "Devices";
  /** `write` scopes change what people see or hear; the console marks them. */
  access: "read" | "write";
}

export const SCOPES = [
  { id: "buildings:read", label: "Read buildings", description: "List buildings and floors.", group: "Campus", access: "read" },
  { id: "rooms:read", label: "Read rooms", description: "Search rooms, see their status and status history.", group: "Campus", access: "read" },
  { id: "rooms:status", label: "Change room status", description: "Set the status of a room (free, occupied, closed…); door screens follow.", group: "Campus", access: "write" },
  { id: "reservations:read", label: "Read reservations", description: "List room bookings.", group: "Campus", access: "read" },
  { id: "announcements:read", label: "Read announcements", description: "List announcements.", group: "Communication", access: "read" },
  { id: "announcements:write", label: "Publish announcements", description: "Publish a text announcement to chosen screens, and cancel one.", group: "Communication", access: "write" },
  { id: "news:read", label: "Read news", description: "List the news shown on the Faculty screens.", group: "Faculty screens", access: "read" },
  { id: "news:write", label: "Manage news", description: "Publish, edit and delete news on the Faculty screens.", group: "Faculty screens", access: "write" },
  { id: "staff:read", label: "Read staff availability", description: "List who is available, busy or away.", group: "Faculty screens", access: "read" },
  { id: "screens:read", label: "Read Faculty screens", description: "List the screens and groups.", group: "Faculty screens", access: "read" },
  { id: "devices:read", label: "Read devices", description: "List enrolled devices and whether they are online.", group: "Devices", access: "read" },
] as const satisfies readonly ScopeDef[];

export type ScopeId = (typeof SCOPES)[number]["id"];
export const SCOPE_IDS = SCOPES.map((s) => s.id) as [ScopeId, ...ScopeId[]];

interface Rule {
  scope: ScopeId;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Matched against the path inside /api, without the query string. */
  path: RegExp;
}

const id = "[A-Za-z0-9_-]{1,64}";
export const RULES: readonly Rule[] = [
  { scope: "buildings:read", method: "GET", path: /^\/buildings\/?$/ },
  { scope: "rooms:read", method: "GET", path: /^\/rooms\/?$/ },
  { scope: "rooms:read", method: "GET", path: /^\/rooms\/floors\/?$/ },
  { scope: "rooms:read", method: "GET", path: new RegExp(`^/rooms/${id}/?$`) },
  { scope: "rooms:read", method: "GET", path: new RegExp(`^/rooms/${id}/status-history/?$`) },
  { scope: "rooms:read", method: "GET", path: /^\/room-statuses\/?$/ },
  { scope: "rooms:status", method: "PUT", path: new RegExp(`^/rooms/${id}/status/?$`) },
  { scope: "reservations:read", method: "GET", path: /^\/reservations\/?$/ },
  { scope: "announcements:read", method: "GET", path: /^\/announcements\/?$/ },
  { scope: "announcements:read", method: "GET", path: new RegExp(`^/announcements/${id}/?$`) },
  { scope: "announcements:write", method: "POST", path: /^\/announcements\/?$/ },
  { scope: "announcements:write", method: "DELETE", path: new RegExp(`^/announcements/${id}/?$`) },
  { scope: "news:read", method: "GET", path: /^\/faculty\/news\/?$/ },
  { scope: "news:write", method: "POST", path: /^\/faculty\/news\/?$/ },
  { scope: "news:write", method: "PUT", path: new RegExp(`^/faculty/news/${id}/?$`) },
  { scope: "news:write", method: "DELETE", path: new RegExp(`^/faculty/news/${id}/?$`) },
  { scope: "staff:read", method: "GET", path: /^\/faculty\/staff\/?$/ },
  { scope: "screens:read", method: "GET", path: /^\/faculty\/screens\/?$/ },
  { scope: "devices:read", method: "GET", path: /^\/devices\/?$/ },
  { scope: "devices:read", method: "GET", path: new RegExp(`^/devices/${id}/?$`) },
];

/** The scope an endpoint belongs to, or null when no key may use it. */
export function scopeFor(method: string, path: string): ScopeId | null {
  return RULES.find((r) => r.method === method.toUpperCase() && r.path.test(path))?.scope ?? null;
}
