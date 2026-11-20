import {
  Building2,
  CalendarClock,
  CalendarDays,
  DoorOpen,
  FileText,
  FileUp,
  GraduationCap,
  Images,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  MonitorPlay,
  Newspaper,
  Plug,
  Palette,
  Radio,
  Settings2,
  Siren,
  Tags,
  UserCheck,
  Users,
  Volume2,
  type LucideIcon,
} from "lucide-react";

export interface SectionItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line shown on the section's hub card. */
  description: string;
  /** Only administrators see this page. */
  adminOnly?: boolean;
}

export interface Section {
  id: string;
  label: string;
  /** What fits under an icon in the rail. */
  short: string;
  icon: LucideIcon;
  /** Where the rail icon leads: the hub page of the section. */
  to: string;
  /** Only admins and operators see this section. */
  managerOnly: boolean;
  summary: string;
  items: SectionItem[];
}

/**
 * The console is organised in a few sections. Each one has a hub page made of cards and a short panel
 * listing its pages, so the navigation stays the same size however many features are added.
 */
const OVERVIEW: Section = {
    id: "overview",
    label: "Overview",
    short: "Overview",
    icon: LayoutDashboard,
    to: "/",
    managerOnly: false,
    summary: "The campus at a glance.",
    items: [],
};

export const SECTIONS: Section[] = [
  OVERVIEW,
  {
    id: "campus",
    label: "Campus",
    short: "Campus",
    icon: Building2,
    to: "/section/campus",
    managerOnly: false,
    summary: "Places, bookings and who is around.",
    items: [
      { to: "/rooms", label: "Rooms", icon: DoorOpen, description: "Search rooms, change their status and see their history." },
      { to: "/buildings", label: "Buildings", icon: Building2, description: "Buildings and floors that rooms belong to." },
      { to: "/reservations", label: "Reservations", icon: CalendarDays, description: "Book rooms. Conflicts are detected and shown on the door." },
      { to: "/availability", label: "Availability", icon: UserCheck, description: "Staff availability shown on the Faculty screens." },
    ],
  },
  {
    id: "devices",
    label: "Devices",
    short: "Devices",
    icon: Radio,
    to: "/section/devices",
    managerOnly: true,
    summary: "Door units, Faculty screens and what they show.",
    items: [
      { to: "/devices", label: "Devices", icon: Radio, description: "Approve connection requests, monitor and configure devices." },
      { to: "/screens", label: "Faculty screens", icon: MonitorPlay, description: "Group screens, set their look and choose what they rotate through." },
      { to: "/media", label: "Media library", icon: Images, description: "Images and videos: upload, rename, replace and delete." },
      { to: "/news", label: "News", icon: Newspaper, description: "Campus news shown on the Faculty screens." },
      { to: "/themes", label: "Themes", icon: Palette, description: "Colours, font and CSS for the door units and the Faculty screens." },
      { to: "/statuses", label: "Room statuses", icon: Tags, description: "The catalogue of statuses a door can show." },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    short: "Comms",
    icon: Megaphone,
    to: "/section/communication",
    managerOnly: true,
    summary: "Announcements, voice and alerts across the campus.",
    items: [
      { to: "/announcements", label: "Announcements", icon: Megaphone, description: "Targeted messages with priority and expiry." },
      { to: "/intercom", label: "InterCom", icon: Volume2, description: "Broadcast audio, recorded, uploaded or spoken." },
      { to: "/schedules", label: "Schedules", icon: CalendarClock, description: "Planned, recurring and status-triggered announcements." },
      { to: "/templates", label: "Templates", icon: FileText, description: "Reusable announcement texts." },
      { to: "/emergency", label: "Emergency", icon: Siren, description: "Campus-wide alerts, tests and the all-clear." },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    short: "Admin",
    icon: Settings2,
    to: "/section/administration",
    managerOnly: true,
    summary: "People and data.",
    items: [
      { to: "/staff", label: "Staff", icon: Users, description: "Accounts, groups and cards." },
      { to: "/students", label: "Students", icon: GraduationCap, description: "Student enrolment and card registration." },
      { to: "/integrations", label: "Integrations", icon: Plug, description: "Read events from an ENT, a student portal or an administration system." },
      { to: "/import", label: "CSV import", icon: FileUp, description: "Bulk import of rooms and people." },
      { to: "/api-keys", label: "API keys", icon: KeyRound, description: "Let other applications use the API with only the scopes they need.", adminOnly: true },
    ],
  },
];

/** Section a pathname belongs to (a hub page, or a page listed in the section). */
export function sectionFor(pathname: string): Section {
  if (pathname === "/") return OVERVIEW;
  const hub = SECTIONS.find((s) => s.to === pathname);
  if (hub) return hub;
  return SECTIONS.find((s) => s.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))) ?? OVERVIEW;
}

/** The pages of a section this person may open. */
export const itemsFor = (section: Section, role: string | undefined) => section.items.filter((i) => !i.adminOnly || role === "admin");
