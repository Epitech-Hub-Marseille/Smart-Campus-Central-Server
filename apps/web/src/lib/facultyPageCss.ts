/**
 * The Faculty screen's own stylesheet for the parts a theme changes (base, header, card, pill, announcement, scene, news),
 * so the console preview draws what a screen draws. It is a copy of the matching rules of
 * `SmartCampus-FacultyScreens/apps/display/src/styles.css`: when the page changes, copy those rules again.
 */
export const FACULTY_PAGE_CSS = `:root {
  --accent: #1d4f9f;
  --accent-ink: #ffffff;
  --ink: #101828;
  --muted: #5b667a;
  --page: #ffffff;
  --card: #f5f7fc;
  --line: #dfe4ee;
  --navy: #111a2b;
  --ok: #1f9d55;
  --warn: #c77700;
  --danger: #d1332b;
  
  font-family: var(--font, "Inter Variable", Inter, system-ui, sans-serif);
  color: var(--ink);
}

html {
  font-size: calc(min(100vw / 120, 100vh / 67.5) * var(--scale, 1));
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--page);
  cursor: none;
}

ul {
  list-style: none;
}

svg {
  flex: none;
}

.screen {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--page);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 6.9rem;
  padding: 0 5rem;
  border-bottom: 1px solid var(--line);
  background: var(--page);
}

.header-brand,
.header-time {
  display: flex;
  align-items: center;
  gap: 1.4rem;
}

.logo {
  height: 3.75rem;
  max-width: 19.2rem;
  object-fit: contain;
}

.divider {
  width: 1px;
  align-self: stretch;
  margin: 1.2rem 0;
  background: var(--line);
}

.header h1 {
  font-size: 2.1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.header-brand p {
  margin-top: 0.15rem;
  font-size: 1.25rem;
  color: var(--muted);
}

.date {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.weekday {
  font-size: 1.2rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

.full-date {
  font-size: 1.9rem;
  font-weight: 600;
}

.clock {
  font-size: 4.1rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.weather {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-right: 1rem;
  color: var(--muted);
}

.weather svg {
  width: 2.2rem;
  height: 2.2rem;
  color: var(--accent);
}

.weather-temp {
  font-size: 2.2rem;
  font-weight: 700;
  color: var(--ink);
}

.weather-label {
  font-size: 1.2rem;
}

.card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 2.2rem 2.4rem;
  border: 0.1rem solid var(--line);
  border-radius: var(--radius, 1.25rem);
  background: var(--card);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
}

.card h2 {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  font-size: 2.1rem;
  font-weight: 700;
}

.card h2 svg {
  width: 1.9rem;
  height: 1.9rem;
  color: var(--accent);
}

.today {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.3rem;
  font-weight: 600;
  color: var(--muted);
}

.today i {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  background: var(--accent);
}

.empty {
  margin: auto;
  font-size: 1.5rem;
  color: var(--muted);
}

.pill {
  display: inline-block;
  padding: 0.15rem 0.85rem;
  border: 0.12rem solid var(--muted);
  border-radius: 999px;
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--muted);
  white-space: nowrap;
}

.pill-now,
.pill-in-use {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
}

.announcements ul {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.announcement {
  flex: 1 1 0;
  max-height: 50%;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.2rem;
  padding: 0.6rem 0 0.6rem 1.5rem;
  border-bottom: 1px solid var(--line);
}

.announcement:last-child {
  border-bottom: 0;
}

.announcement::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.9rem;
  bottom: 0.9rem;
  width: 0.45rem;
  border-radius: 0.25rem;
  background: #98a2b3;
}

.priority-important::before {
  background: var(--accent);
}

.priority-urgent::before {
  background: var(--danger);
}

.announcement strong {
  font-size: 1.7rem;
  font-weight: 700;
}

.announcement p {
  font-size: 1.45rem;
  line-height: 1.35;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.scene {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 2rem;
  padding: 2.2rem 5rem 2.4rem;
  background: var(--page);
}

.tile-board {
  height: 100%;
  min-height: 0;
  display: grid;
  gap: 2rem;
}

.news-tile {
  grid-template-rows: auto 1fr;
}

.news-list {
  display: flex;
  flex-direction: column;
  gap: 1.6rem;
  overflow: hidden;
}

.news-card {
  display: flex;
  gap: 1.4rem;
  align-items: flex-start;
  font-size: 1.7rem;
}

.news-card strong {
  display: block;
  font-size: 2rem;
}

.news-card p {
  margin-top: 0.4rem;
  color: var(--muted);
}

.ticker-tag {
  flex: none;
  padding: 0.25rem 0.8rem;
  border-radius: 0.5rem;
  font-size: 1.1rem;
  letter-spacing: 0.08em;
  color: #fff;
  background: var(--accent);
}

.tag-important {
  background: var(--warn);
}

.tag-urgent {
  background: var(--danger);
}`;

/** The same for an alert: the rules of the emergency takeover, so the preview shows what a screen shows when one starts. */
export const FACULTY_ALERT_CSS = `html {
  font-size: calc(min(100vw / 120, 100vh / 67.5) * var(--scale, 1));
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--page);
  cursor: none;
}

ul {
  list-style: none;
}

svg {
  flex: none;
}

.emergency,
.end-notice {
  --yellow: #ffff55;
  --kind: #a80000;
  --bg: var(--em-solid, var(--kind));
  display: flex;
  height: 100%;
  padding: 2.5rem 4rem;
  background: var(--bg);
  color: #fff;
  font-family: var(--em-font-body, ui-monospace, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace);
  font-weight: 700;
}

.emergency[data-kind="biohazard"] { --kind: #1f5f1f; }

.emergency[data-kind="nuclear"] { --kind: #5a4a00; }

.emergency[data-kind="bomb"] { --kind: #8a0030; }

.emergency[data-kind="seismic"] { --kind: #8a3a00; }

.emergency[data-kind="power"] { --kind: #0a3d8a; }

.end-notice { --kind: #0a5a1f; }

.alert-frame {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 1.4rem;
  padding: 1.8rem 2.2rem 0;
  border: 0.3rem solid #fff;
  border-radius: var(--em-radius, 0);
  box-shadow: inset 0 0 0 0.5rem var(--bg), inset 0 0 0 0.7rem #fff;
  overflow: hidden;
}

.alert-head {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
  padding: 0.5rem 1.2rem;
  background: #fff;
  color: var(--bg);
  font-size: 1.8rem;
  letter-spacing: 0.06em;
  border-radius: var(--em-radius, 0);
}

.alert-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2.4rem;
}

.alert-title svg {
  width: 7.5rem;
  height: 7.5rem;
  color: #000;
  fill: var(--yellow);
  stroke-width: 1.6;
}

.alert-title h1 {
  font-family: var(--em-font-heading, inherit);
  font-size: 8.2rem;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--yellow);
}

.alert-detail {
  text-align: center;
  font-size: 2.9rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.alert-call {
  align-self: center;
  padding: 0.6rem 2.4rem;
  background: #fff;
  color: var(--bg);
  font-size: 3.6rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: var(--em-radius, 0);
}

.steps {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 1.2rem 0 0;
  border-top: 0.2rem dashed #fff;
  background: var(--em-card, transparent);
  list-style: none;
  font-size: 2.5rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  overflow: hidden;
}

.steps li {
  padding: 0.2rem 1.2rem;
  border-radius: var(--em-radius, 0);
}

.steps li span {
  color: var(--yellow);
}

.steps li:first-child {
  background: #fff;
  color: var(--bg);
}

.steps li:first-child span {
  color: inherit;
}

.alert-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.7rem 1.6rem;
  background: var(--yellow);
  color: #000;
  font-size: 3rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: var(--em-radius, 0);
}

.stripes {
  flex: none;
  height: 5rem;
  margin: 0 -2.2rem;
  background: repeating-linear-gradient(45deg, var(--yellow) 0 2.4rem, #000 2.4rem 4.8rem);
}

.frame-bar .stripes {
  height: 2.2rem;
  background: var(--yellow);
}

.end-notice .alert-frame {
  padding-bottom: 2.2rem;
  justify-content: center;
}

.end-notice .alert-detail {
  font-size: 3.4rem;
  line-height: 1.3;
  text-transform: none;
}

.end-notice .alert-title svg {
  fill: none;
  color: var(--yellow);
}`;
