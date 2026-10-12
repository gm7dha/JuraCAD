import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  Box: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </Svg>
  ),
  Cylinder: (p: IconProps) => (
    <Svg {...p}>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6" />
    </Svg>
  ),
  Sphere: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="8.5" ry="3.2" />
    </Svg>
  ),
  Undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  ),
  Redo: (p: IconProps) => (
    <Svg {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  ),
  Export: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 17v3h16v-3" />
    </Svg>
  ),
  Help: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01" />
    </Svg>
  ),
  Eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  ),
  EyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 3l18 18M10.6 5.6A10 10 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4M6.5 6.6C3.8 8.3 2 12 2 12s3.6 6.5 10 6.5c1.8 0 3.3-.5 4.6-1.2" />
      <path d="M9.9 9.9a2.8 2.8 0 0 0 4 4" />
    </Svg>
  ),
  Origin: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" />
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
    </Svg>
  ),
  Plane: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 15.5 9 7h12l-6 8.5z" />
    </Svg>
  ),
  Part: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" fill="currentColor" fillOpacity={0.15} />
    </Svg>
  ),
  Sketch: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20h16" />
      <path d="M14.5 4.5 19.5 9.5 9 20H4v-5z" />
    </Svg>
  ),
  Extrude: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 17h10l6-4H10z" />
      <path d="M12 13V3M9 6l3-3 3 3" />
    </Svg>
  ),
  Revolve: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 2v20" strokeDasharray="2 2" />
      <path d="M17 6.5a8 3 0 1 1-10 0" />
      <path d="m15 4 2 2.5-2.6 1" />
    </Svg>
  ),
  Fillet: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V10a6 6 0 0 1 6-6h10" />
    </Svg>
  ),
  Shell: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="6" width="16" height="14" rx="1" />
      <rect x="7.5" y="9.5" width="9" height="7" />
    </Svg>
  ),
  Warning: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  ),
  Tick: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  ),
  Cross: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Fit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  ),
  New: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4M12 11v6M9 14h6" />
    </Svg>
  ),
};
