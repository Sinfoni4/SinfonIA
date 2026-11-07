/** Stroke icons of the Mini App (decorative: the text next to them says the same). */

type IconProps = { size?: number; color?: string };

function Svg({
  size = 22,
  color = 'currentColor',
  width = 2.2,
  children,
}: IconProps & { width?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const MenuIcon = (p: IconProps) => (
  <Svg {...p} width={2.4}>
    <path d="M5 9h14M5 15h14" />
  </Svg>
);
export const BackIcon = (p: IconProps) => (
  <Svg {...p} width={2.4}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p} width={2.4}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const CloseIcon = (p: IconProps) => (
  <Svg {...p} width={2.4}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5" width="16" height="15" rx="3" />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </Svg>
);
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const FolderPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 10v6M9 13h6" />
  </Svg>
);
export const DocIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 14l2 2 4-4" />
  </Svg>
);
export const DocPlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 12v5M9.5 14.5h5" />
  </Svg>
);
export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);
export const HomeIcon = (p: IconProps) => (
  <Svg {...p} width={2}>
    <path d="M3 21V9l9-6 9 6v12" />
    <path d="M9 21v-7h6v7" />
  </Svg>
);
export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const ArrowIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </Svg>
);
export const UploadIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
  </Svg>
);
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </Svg>
);
export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);

/** The SinfonIA mark: three sound bars in a green ring. */
export function Logo({ size = 34, label = true }: { size?: number; label?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      {...(label ? { role: 'img', 'aria-label': 'SinfonIA' } : { 'aria-hidden': true })}
    >
      <circle cx="17" cy="17" r="14.5" fill="none" stroke="#5be49b" strokeWidth="2.4" />
      <path
        d="M11.5 20.5v-7M17 24v-14M22.5 21v-8"
        stroke="#eef1ea"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The ring with the share of confirmed documents (empty when nothing is expected). */
export function Ring({ percent }: { percent: number | null }) {
  const length = 2 * Math.PI * 20;
  const filled = percent === null ? 0 : (length * percent) / 100;
  return (
    <div
      className="ma-ring"
      role="img"
      aria-label={
        percent === null ? 'Nessun documento previsto' : `Documenti confermati: ${percent}%`
      }
    >
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth="4"
        />
        <circle
          cx="24"
          cy="24"
          r="20"
          fill="none"
          stroke="#5be49b"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${length}`}
          transform="rotate(-90 24 24)"
        />
      </svg>
      <span aria-hidden="true">{percent === null ? '–' : percent}</span>
    </div>
  );
}
