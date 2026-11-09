# SmartCampus Central Server

Monolith: React + Vite + Tailwind v4 + shadcn/ui console, Express + MongoDB server with a WSS device gateway, pnpm workspaces.
In production one container serves the API (`/api/*`), the device gateway (`/ws/device`) and the built SPA.

```
apps/server/         Express (TypeScript), Mongoose, WSS gateway
apps/web/            React (TypeScript), Vite admin console
apps/device-sim/     Python device simulator to exercise the WSS protocol
packages/protocol/   message envelope + zod schemas shared by every client
packages/handshake/  mutual authentication + AES-256-GCM channel (node:crypto)
docs/                technical deck
Dockerfile           production image (multi-stage)
docker-compose.yml      production
docker-compose.dev.yml  development, hot reload
```

## Run

```bash
# Dev: http://localhost:5173  (login: admin@smartcampus.local / changeme123)
docker compose -f docker-compose.dev.yml up

# Prod: http://localhost:3000
cp .env.example .env   # set SEED_ADMIN_PASSWORD
docker compose up -d --build
```

Without Docker: `pnpm install`, `pnpm --filter './packages/*' build`, then `pnpm --filter @smartcampus/server dev` and `pnpm --filter @smartcampus/web dev`, with MongoDB on localhost:27017.

The single `pnpm-lock.yaml` at the root is committed.

## Features

| Area | What |
| --- | --- |
| Roles and groups | A person belongs to any of the groups `admin`, `operator`, `student`. The console role follows from them: `admin` (everything), `operator` (campus data, students and plain staff accounts), anyone else read-only. A student can also be an operator or an administrator |
| Cards | NFC card serial number per person. An admin or operator card opens the maintenance menu on a reader. Students are enrolled with their card, one by one or in bulk through a reader in registration mode (see [Card authentication](#card-authentication)) |
| Campus | Buildings, rooms, people (staff = user accounts): create, edit, delete. Rooms are searchable and filterable by building, floor and type |
| Password reset | `POST /api/auth/forgot-password` + `/reset-password`; single-use hashed token by email. Also used for account invitations |
| Sessions | Idle timeout (`SESSION_IDLE_MINUTES`) and hard limit (`SESSION_TTL_HOURS`), enforced server-side; the UI warns 60 s before signing out |
| Devices | Console page: approve or deny connection requests from new devices, see who is online live, edit, revoke, send commands and follow their delivery, compare desired and reported state. Offline alerts. Admins and operators only |
| Room status | Free, occupied, closed and works built in, plus custom statuses (label, colour, icon). Changing a status is stored with its history, pushed to the door screens of the room and audited |
| Announcements | Text announcements on door and faculty screens, targeted by device, group, building, floor or everyone, with priority (info, important, urgent) and an expiry the screen enforces by itself |
| Emergency alerts | Fire, biohazard, radiation leak, bomb threat, earthquake and power cut. Takes over the door screens (door code, chevrons towards the emblem, procedure) and loops a synthesised alarm until ended. Test mode shows a TEST tag and plays at a chosen volume. Kept in the digital twin, so an offline screen sounds the alarm when it reconnects and stops if the alert ended meanwhile. A real alert needs two steps enforced by the API, can also be read aloud, and ends with a message shown on the screens (see [Emergency alerts](#emergency-alerts)) |
| InterCom | Record or import a sound (stored in GridFS, WAV/MP3/Ogg/WebM/M4A, `MAX_AUDIO_MB`), broadcast it to chosen devices. Devices download it over a request signed with their key. Volume and quiet hours per device. **Voice announcements**: type a text, choose a language and a voice, listen to it, then broadcast it (see [Voice and schedules](#voice-announcements-schedules-and-templates)) |
| Schedules and templates | Announcements that send themselves once, daily, weekly, or when a room changes status; a library of reusable announcement texts |
| Faculty screens | The information board of the reference design (events of the day, booked rooms, announcements, a news ticker) plus staff availability (updated by the staff themselves, filtered by service), with carousel, clock, date and weather widgets. The screen application is in its own repository, `SmartCampus-FacultyScreens` |
| Custom content | Images, videos, texts and live web pages for the Faculty screens, each with a duration, a schedule and targets (everyone, buildings, floors, groups, devices); a screen shows the board, the custom content, or both taking turns |
| Reservations | Book a room without conflicts; the door screen shows the next booking and Faculty screens list the day |
| Display config | Layout, theme, visible elements and night sleep per screen, validated by the shared schema, duplicated to several screens |
| Audit | `auditLogs` entries for device approval/revocation, status changes, announcements, emergency alerts, uploads, broadcasts and configuration changes (the viewer is #27) |
| CSV import | `/import` page and `POST /api/import/{rooms,users}`; preview (`dryRun`) before writing, per-line errors, upsert |

The door terminal app is in its own repository, [SmartCampus-DoorUnit](https://github.com/liam-colle/SmartCampus-DoorUnit) (Kotlin, Android). Without hardware, `apps/device-sim` plays the same role.

Dev mails are caught by Mailpit at http://localhost:8025.

## Voice announcements, schedules and templates

**Voice.** The text-to-speech engine sits behind the `TtsEngine` interface (`apps/server/src/infra/tts.ts`); the vendor is still an open
decision, so the shipped implementation speaks the OpenAI `POST /audio/speech` API, which hosted services and self-hosted engines
(a Piper wrapper for example) both offer. Set `TTS_URL` (and `TTS_API_KEY`, `TTS_MODEL`) and list the voices the console offers in
`TTS_VOICES` as `id|label|language`. Without `TTS_URL` the voice features answer 501 and the console says so.

- `GET /api/intercom/voices`, `POST /api/intercom/speech/preview {text, voice}` (pre-listening: returns audio, stores and sends nothing),
  `POST /api/intercom/speech {text, voice, targets}` (generates, keeps the sound in the library, broadcasts it like any InterCom sound).
- **Local engine on an NVIDIA GPU**: `docker compose -f docker-compose.dev.yml -f docker-compose.tts.yml up` adds a
  [Kokoro](https://github.com/remsky/Kokoro-FastAPI) container (OpenAI-compatible, `127.0.0.1:8880`, no authentication so never exposed) and points the server at it
  (`TTS_URL`, `TTS_VOICES` with English and French voices). Needs Docker Desktop (WSL2) and an NVIDIA driver; the first start downloads several GB.
  If the container falls back to CPU or fails on an older GPU, see its logs: the image's CUDA build must support your card.
- The text is limited to 1000 characters and synthesis is rate-limited per person (20 a minute). The reply must really be audio (sniffed)
  and not larger than `MAX_AUDIO_MB`. The engine's error text is never passed to the console.

**Schedules** (`/schedules`, admins and operators). A schedule announces a text (on screens) or a voice, at a time or on an event:

| Trigger | Meaning |
| --- | --- |
| `once` | at a date and time |
| `daily`, `weekly` | at `HH:MM` in `CAMPUS_TIMEZONE` (default `Europe/Paris`, daylight saving handled), on chosen days for `weekly` |
| `status` | when a room becomes a given status (any room, or one); goes to the screens of the room that changed unless targets are given. At most once a minute per schedule |

Schedules live in MongoDB and a 15 s loop (`jobs/scheduler.ts`) runs the due ones: no Redis, no extra service (the deck planned Agenda; the
need is small enough that a conditional update does the job, and nothing prevents switching later). A schedule is claimed by moving its
`nextRunAt` in one conditional update, so two server processes would not both run it. A run that is more than 10 minutes late (server
was down) is **skipped and reported**, not sent late. Content is copied into the schedule when it is created. Failures are kept on the
schedule (`lastError`), shown in the console, and never block the status change that triggered them.

**Templates** (`/announcement-templates`, admins and operators): reusable texts, either for screens or for a voice. Using one copies it into the
announcement, voice or schedule form.

## Faculty screens

Displays (`type: display`) get two commands. `faculty.config.set` is the look (staff service filter, carousel interval and slides, clock/date/weather
widgets; weather needs a latitude and longitude and is fetched by the screen itself) and is part of the digital twin. `faculty.content.set` is a
snapshot of news, staff availability and today's reservations. The snapshot is **not** kept in the twin: it is derived data and would not fit in
`session.ready`, so the server rebuilds it when the screen connects and whenever news, availability, reservations or the directory change. Counts
and field lengths are bounded (8 news, 40 staff, 15 reservations) so the worst case fits a frame; a test proves it.

- `/faculty/news` (read by all, written by admins and operators), `/faculty/staff?service=`, `PUT /faculty/availability/me` (everyone updates their own
  status, with a note and an optional end time after which they show as available again), `PUT /faculty/availability/:userId` (admin, operator),
  `GET/PUT /faculty/displays`. A person is listed once an admin or operator sets their `service` (`pedagogical` or `administrative`) in the staff directory.
- The Faculty display application is `SmartCampus-FacultyScreens`: an edge agent that holds the device key and this link, and a kiosk page. `apps/device-sim` logs what such a screen would show.

### Custom content

The media library takes images and videos next to the sounds: `POST /api/assets/media?name=…` (raw body, `MAX_MEDIA_MB`), `GET /api/assets?kind=image|video` (without `kind`, the sound library, as before). The kind and type are decided from the file's first bytes: PNG, JPEG, WebP, GIF, MP4 and WebM, never SVG (it can carry scripts) and never an audio-only MP4. A file used by a slide or a screen logo cannot be deleted.

Slides (`/api/content`, admins and operators) are an image or video from the library, a text (400 characters), or an http(s) web page reloaded every `refreshSeconds`, with `durationSeconds` (3 to 600), `fit`, an optional window (`startsAt`, `endsAt`), `targets` (the same selectors as announcements) and `enabled`. Each Faculty screen gets its playlist as `content.set`: the enabled slides that are not over and that target it, at most 24, with the file references (`assetId`, `sha256`, `size`, `mime`) built from the library, never from the request. The playlist is derived data: it is rebuilt when a slide changes, on every connection and every 30 minutes, and is not kept in the digital twin. A screen set to `default` mode receives an empty one, so it downloads nothing. The screen applies the dates itself, so a schedule works through an outage, and it only switches to a new playlist once every file is downloaded and verified (it acknowledges then, or answers `nack`).

A screen downloads a file with a signed request, as for sounds, and only a file its own playlist or logo names (`audio.play`, `content.set` and `faculty.config.set` are what authorise a download).

The screen's look is part of `faculty.config.set`: `mode` (`default`, `custom` or `mixed`) and `site` (name, subtitle, zone, assembly point, emergency number and logo), which the board's header and the emergency screen use.

## Reservations

`POST /api/reservations {roomId, title, start, end}` books a room; anyone signed in may book and cancel their own, admins and operators cancel any
(a deliberate exception to "staff are read-only": booking a room is an everyday task). Overlaps answer 409 naming what is in the way; slots
that touch (10:00-11:00 then 11:00-12:00) are fine; a booking lasts at most 12 hours. MongoDB cannot enforce "no overlap", so the booking is
inserted and then checked, and of two simultaneous overlapping bookings only the later one backs out. Door screens receive `reservations.set` (the next
five within 48 h, kept in the twin, refreshed every 30 minutes so past ones leave the list); `displayConfig.show.nextReservation` hides it.

## Emergency alerts

A real alert takes two steps, enforced by the API and not only by the console: `POST /api/emergencies/confirmations` (same body) validates that the alert
reaches screens and returns how many plus a single-use token valid for 60 s; `POST /api/emergencies` must carry it as `confirmation`. The token is bound to the person
and to the exact alert (kind, targets, wording, voice), is stored hashed and is consumed atomically. A test alert needs none. `speak: true` also reads the
instructions aloud with the **emergency voice** (`TTS_EMERGENCY_VOICE`, a serious male voice; read at `TTS_EMERGENCY_SPEED`, 0.9 by default, after an "Attention. Attention." opening; the all-clear uses the same voice at a natural pace; a voice named in the request wins; an unknown configured voice falls back to the first one rather than silencing the read-out) as `audio.play` with `urgent`, which ignores quiet hours; it is done after the alarm is queued and its failure is recorded on the alert
(`voice.status`) without affecting it. `POST /api/emergencies/:id/clear {message?, noticeSeconds?, speak?}` ends an alert with a notice the screens show afterwards
(`emergency.clear.message`, for `noticeSeconds`: 10 to 900, 120 when omitted; `GET /api/emergencies/end-notice` serves the limits); `DELETE /api/emergencies/:id` still ends it without one.

## Device gateway

Devices (door units, faculty displays, access units) connect to `/ws/device` and authenticate with a
mutual, signed-session handshake (ECDSA P-256, ephemeral ECDH, AES-256-GCM frames), so identity does not
depend on TLS alone. Protocol: `packages/protocol/README.md`. Design: `docs/SmartCampus-CentralServer_Technical_Deck.pdf`.

- **Server key**: `SERVER_KEY_FILE` (PKCS#8 PEM). Generated on first start in development
  (`secrets/server-key.pem`, public half in `secrets/server-key.pub`, git-ignored). In production create it with
  `pnpm --filter @smartcampus/server keys:generate secrets/server-key.pem` and mount it as a secret. Devices are provisioned with the public key: the console shows a QR code (Devices, Provision a device) and the key is also served, public, at `GET /api/server-key` for a terminal that fetches it and has its fingerprint confirmed by the installer.
- **Enrollment**: a new device posts its public key to `POST /api/enroll` and waits (it polls `GET /api/enroll/:deviceId`). The request
  appears live in the console as a **connection request** (type, name, key fingerprint, source address); an admin or operator approves it
  (optionally naming and placing the device) or denies it. Nothing is typed. Requests expire (`ENROLL_REQUEST_TTL_MINUTES`), at most
  `MAX_PENDING_ENROLLMENTS` wait at once, and a denied key cannot ask again for an hour. The fingerprint is shown so it can be compared with the one on the device.
  `POST /api/devices/:id/revoke` cuts a device off immediately.
- **Commands**: `POST /api/devices/:id/commands {type, payload}` goes through an outbox, is delivered now or replayed on reconnect.
- **Console channel**: `/ws/admin` (session cookie, admins and operators) pushes device online/offline events.
- **Test it** without hardware: `python3 apps/device-sim/sim.py selftest` (see `apps/device-sim/README.md`).
- **Console**: the Devices page (`/devices`) wraps all of the above.
- TLS for the device-facing listener (self-signed certificate and pinning) is not done yet, see issue #12.

## Authentication

- `POST /api/auth/login {email, password}` sets an httpOnly `sc_sid` cookie holding an opaque random token; only its SHA-256 is stored in the `sessions` collection (TTL-expired by MongoDB).
- `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/auth/providers`.
- Passwords are hashed with scrypt. Login is rate-limited; state-changing requests are Origin-checked.
- There is no sign-up. Create users with the seed env vars or
  `docker compose -f docker-compose.dev.yml exec server pnpm user:create <email> <password> [name] [admin|operator|staff]`.

### Card authentication

A person can have an NFC card (`users.cardUid`, the serial number as upper-case hex, unique). A reader (access unit or
door unit) sends `event.badge` with the serial number it read and the server answers `card.result`:

| Outcome | Meaning |
| --- | --- |
| `maintenance` | enabled admin or operator: the reader opens its maintenance menu |
| `recognised` | known student or staff card, no menu |
| `unknown`, `disabled`, `rate_limited` | refused; a reader may present 30 cards a minute |
| `captured`, `duplicate`, `already_registered` | the reader is in registration mode |

Groups are edited on the Staff page (`PATCH /api/users/:id {groups, cardUid}`); an operator can only manage people who are neither
admin nor operator, so they cannot promote anyone. Group and card changes and every `maintenance.open` are written to `auditLogs`
(card numbers are not).

**Students and registration mode.** `POST /api/students` creates a student (name and card, no password, no email needed). To
enrol a class: Students, Register cards, pick a reader. `POST /api/card-registration {deviceId}` puts that reader in registration mode
(`registration.mode.set`, kept in the digital twin); every card presented is collected, and shown live in the console, until the admin
stops it (`DELETE /api/card-registration/:id`) or 10 minutes pass. The cards are then named and created with `POST /api/students/bulk`.
The maintenance menu runs `maintenance.action` messages (`status.set` on the terminal's room, `restart`, `revoke`), accepted only inside a short
sliding grant opened by the card on that connection and re-checked against the person each time (enabled, operator or admin; revoke is
admin only). Each is written to `auditLogs` (`room.status.set`, `maintenance.restart`, `maintenance.revoke`).
While collecting, the reader does not open its maintenance menu, which is why the window is short and ends by itself on the reader too.

**Decision: the server decides, the card is only an identifier.** The reader does not keep a list of who may open the menu, so removing
someone from a group takes effect at their next tap; the cost is that the menu needs the link to the server. Alternative rejected: pushing
the privileged cards to the readers (`access.acl.sync`), which also works offline but keeps working for a removed person until the
reader reconnects.

**Known limitation.** A serial number is not a secret: many cards and phones can be cloned or emulated, so anyone who has read an
administrator's number can present it. Mitigations in place: only an enrolled, authenticated device can ask (the handshake, not the
card, proves the reader), a disabled person is refused, taps are rate limited per reader and every opening of the menu is audited.
The menu itself should not offer anything that cannot be undone from the console. A second factor (PIN on the reader, or a card that
answers a challenge such as DESFire or a phone credential) is the way to close this properly and is not done.

Existing databases are migrated at start (`migrate.ts`): the stored `role` becomes the matching group and the field is dropped, and the
unique email index is rebuilt so that people without an email can coexist. Not yet in the repository: the maintenance menu screen itself, which belongs to
the reader software (`apps/edge-agent` for the access unit, the door app for the Famoco). The simulator prints `MAINTENANCE MENU OPEN`
(`sim.py run --taps`).

### Azure SSO (paved, not implemented)

Already in place: `users.identities[]` (provider + stable subject), `/api/auth/azure/login|callback` routes,
`auth/identity.ts` (link/auto-provision), shared `startSession`, `AZURE_*` config, and a
"Sign in with Microsoft" button shown when `AZURE_ENABLED=true`.
Remaining: implement `getAuthorizationUrl` and `handleCallback` in `apps/server/src/auth/providers/azure.ts` (see the comment there).

## Adding shadcn components

`cd apps/web && pnpm dlx shadcn@latest add dialog` (config in `components.json`).
