import {
  Building2,
  CalendarClock,
  CalendarDays,
  DoorOpen,
  FileText,
  FileUp,
  GraduationCap,
  Images,
  LayoutDashboard,
  Megaphone,
  MonitorPlay,
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
}

export interface Section {
  id: string;
  label: string;
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
    icon: Radio,
    to: "/section/devices",
    managerOnly: true,
    summary: "Door units, Faculty screens and what they show.",
    items: [
      { to: "/devices", label: "Devices", icon: Radio, description: "Approve connection requests, monitor and configure devices." },
      { to: "/faculty", label: "Faculty screens", icon: MonitorPlay, description: "News, carousel and widgets of the information screens." },
      { to: "/content", label: "Custom content", icon: Images, description: "Image and video library, slides and playlists." },
      { to: "/statuses", label: "Room statuses", icon: Tags, description: "The catalogue of statuses a door can show." },
    ],
  },
  {
    id: "communication",
    label: "Communication",
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
    icon: Settings2,
    to: "/section/administration",
    managerOnly: true,
    summary: "People and data.",
    items: [
      { to: "/staff", label: "Staff", icon: Users, description: "Accounts, groups and cards." },
      { to: "/students", label: "Students", icon: GraduationCap, description: "Student enrolment and card registration." },
      { to: "/import", label: "CSV import", icon: FileUp, description: "Bulk import of rooms and people." },
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
