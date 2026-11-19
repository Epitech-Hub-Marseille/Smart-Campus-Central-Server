import type { EmergencyKind } from "@/lib/types";

/** Dark background of each kind of alert, the same as on the door units and the Faculty screens. */
const BACKGROUND: Record<EmergencyKind, string> = {
  fire: "#a80000",
  biohazard: "#1f5f1f",
  nuclear: "#5a4a00",
  bomb: "#8a0030",
  seismic: "#8a3a00",
  power: "#0a3d8a",
};

const YELLOW = "#ffff55";

/** The order and the steps people read, short and fixed (the same words as the devices). */
const ORDER: Record<EmergencyKind, string> = {
  fire: "EVACUATE NOW",
  biohazard: "STAY INSIDE",
  nuclear: "SHELTER NOW",
  bomb: "LEAVE CALMLY",
  seismic: "DROP, COVER, HOLD",
  power: "STAY CALM",
};

/**
 * What the door screen shows during an emergency: the bulletin of the Faculty screens at the size of a door, with the door
 * code, the alert in yellow, what is happening, the order to follow and hazard stripes. Sizes are in `em`, so it scales with
 * its container.
 */
export function EmergencyPreview({
  kind,
  title,
  instructions,
  doorCode = "A-101",
  testMode,
}: {
  kind: EmergencyKind;
  title: string;
  instructions: string;
  doorCode?: string;
  testMode: boolean;
}) {
  const background = BACKGROUND[kind] ?? BACKGROUND.fire;
  return (
    <div className="@container w-full">
      <div
        className="aspect-video w-full overflow-hidden rounded-xl border p-[2.5%] font-mono text-[1.5cqw] font-bold text-white"
        style={{ background }}
        role="img"
        aria-label={`Door screen preview: ${title}${testMode ? ", test" : ""}`}
      >
        <div className="flex h-full flex-col gap-[0.9em] border-[0.2em] border-white p-[0.4em]">
          <div className="flex h-full flex-col gap-[0.9em] border-[0.1em] border-white px-[1em] py-[0.8em]">
            <div className="flex justify-between bg-white px-[0.8em] py-[0.3em] text-[0.9em]" style={{ color: background }}>
              <span>&gt;&gt; SMART CAMPUS SECURITY SYSTEM [S.C.S.S]</span>
              <span>{testMode ? "TEST - NO REAL EMERGENCY" : `[${doorCode}]`}</span>
            </div>
            <div className="text-center text-[2.6em] leading-none tracking-wide uppercase" style={{ color: YELLOW }}>
              {title}
            </div>
            <p className="text-center text-[1.15em] tracking-wide uppercase">{instructions}</p>
            <div className="self-center bg-white px-[1.4em] py-[0.3em] text-[1.6em]" style={{ color: background }}>
              &gt;&gt; {ORDER[kind] ?? ORDER.fire} &lt;&lt;
            </div>
            <div className="mt-auto -mx-[0.6em] h-[1.6em]" style={{ background: `repeating-linear-gradient(45deg, ${YELLOW} 0 0.8em, #000 0.8em 1.6em)` }} aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
