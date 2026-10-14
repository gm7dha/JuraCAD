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
  Import: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v10M8 9.5l4 4 4-4" />
      <path d="M4 14.5v4A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-4" />
    </Svg>
  ),
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
  Chamfer: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V10l6-6h10" />
    </Svg>
  ),
  Variables: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7c2 0 2 10 4 10M4 17c2 0 4-10 6-10" />
      <path d="M13 10h7M13 14h7" />
    </Svg>
  ),
  Move: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18M3 12h18" />
      <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </Svg>
  ),
  Section: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 8 12 4l8 4v8l-8 4-8-4z" />
      <path d="M2 13h20" strokeDasharray="2 2" />
      <path d="M4 13h16l-4 2.5H8z" fill="currentColor" opacity="0.35" />
    </Svg>
  ),
  Mirror: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 7 4 17h5zM15 7l5 10h-5z" />
    </Svg>
  ),
  LinearPattern: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="9" width="5" height="6" rx="1" />
      <rect x="10" y="9" width="5" height="6" rx="1" />
      <rect x="17" y="9" width="4" height="6" rx="1" strokeDasharray="2 1.5" />
    </Svg>
  ),
  CircularPattern: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7" strokeDasharray="2 2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="18.1" cy="15.5" r="2" />
      <circle cx="5.9" cy="15.5" r="2" />
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
  Draft: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 20l3-16h6l3 16z" />
      <path d="M12 2v6" strokeDasharray="2 2" />
    </Svg>
  ),
  MoveFace: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 10h10v10H4z" />
      <path d="M14 10l4-4M14 20l4-4M18 6v10" strokeDasharray="2 2" />
      <path d="M8 6l4-4 4 4" />
    </Svg>
  ),
  DeleteFace: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V8a4 4 0 0 1 4-4h12" strokeDasharray="2 2" />
      <path d="M4 20h16V4" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </Svg>
  ),
  Split: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7l6-3 0 16-6-3z" />
      <path d="M14 4l6 3v10l-6 3z" />
    </Svg>
  ),
  Thicken: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 16l9-4 9 4-9 4z" />
      <path d="M3 16v-4l9-4 9 4v4" strokeDasharray="2 2" />
      <path d="M12 12V6M10 8l2-2 2 2" />
    </Svg>
  ),
  Rib: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20h16M4 20V4" />
      <path d="M4 14l6 6" />
      <path d="M4 10l10 10" fill="currentColor" opacity="0.35" />
    </Svg>
  ),
  Boolean: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9.5" cy="12" r="5.5" />
      <circle cx="14.5" cy="12" r="5.5" />
    </Svg>
  ),
  Settings: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </Svg>
  ),
  Explode: (p: IconProps) => (
    <Svg {...p}>
      <rect x="9" y="9" width="6" height="6" />
      <path d="M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z" />
      <path d="M7.5 7.5 9 9M16.5 7.5 15 9M7.5 16.5 9 15M16.5 16.5 15 15" />
    </Svg>
  ),
  Fit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  ),
  Select: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3l14 8-6 1.5L10 19z" />
    </Svg>
  ),
  Line: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" />
      <circle cx="19" cy="5" r="1.6" fill="currentColor" />
    </Svg>
  ),
  Rectangle: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="6" width="16" height="12" />
    </Svg>
  ),
  CentreRectangle: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="6" width="16" height="12" />
      <path d="M4 6l16 12" strokeDasharray="2 2" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </Svg>
  ),
  TangentArc: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 18h8" />
      <path d="M11 18a6 6 0 0 0 6-6V5" />
      <circle cx="11" cy="18" r="1.5" fill="currentColor" />
    </Svg>
  ),
  SketchPattern: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="18" cy="12" r="2.5" strokeDasharray="2 1.5" />
    </Svg>
  ),
  AutoDimension: (p: IconProps) => (
    <Svg {...p}>
      <rect x="6" y="9" width="12" height="9" />
      <path d="M6 5h12M6 3.5v3M18 3.5v3M21 9v9M19.5 9h3M19.5 18h3" />
      <path d="M3 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  BaselineDim: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V6M4 9h8M4 13h12M4 17h16" />
      <path d="M12 7v4M16 11v4M20 15v4" />
    </Svg>
  ),
  ChainDim: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 14h18M3 10v8M9 10v8M15 10v8M21 10v8" />
    </Svg>
  ),
  OrdinateDim: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V8M10 20v-9M16 20V9M4 8V4M10 11V4M16 9V4" />
      <path d="M2 20h18" />
    </Svg>
  ),
  Detail: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="4" />
      <circle cx="15" cy="15" r="6" />
      <path d="M11 11l1 1" />
    </Svg>
  ),
  Thread: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 3v18M16 3v18" />
      <path d="M8 5l8 2M8 9l8 2M8 13l8 2M8 17l8 2" />
    </Svg>
  ),
  ChevronLeft: (p: IconProps) => (
    <Svg {...p}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  ),
  ChevronRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  ),
  Circle: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </Svg>
  ),
  Arc: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 18a9 9 0 0 1 16 0" />
      <circle cx="4" cy="18" r="1.6" fill="currentColor" />
      <circle cx="20" cy="18" r="1.6" fill="currentColor" />
      <circle cx="12" cy="9" r="1.6" fill="currentColor" />
    </Svg>
  ),
  Point: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </Svg>
  ),
  Hole: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 9h18v10H3z" />
      <path d="M9 9v10M15 9v10" strokeDasharray="2 1.5" />
      <path d="M8 9V5h8v4" />
    </Svg>
  ),
  Slot: (p: IconProps) => (
    <Svg {...p}>
      <rect x="2.5" y="8" width="19" height="8" rx="4" />
      <path d="M6.5 12h11" strokeDasharray="2 2" />
    </Svg>
  ),
  Polygon: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.5 19.4 7.8v8.4L12 20.5l-7.4-4.3V7.8z" />
    </Svg>
  ),
  CornerRound: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 20V12a8 8 0 0 1 8-8h8" />
      <path d="M4 4h4M4 4v4" strokeDasharray="1.5 1.5" />
    </Svg>
  ),
  Trim: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <path d="M8.2 8.3 20 16M8.2 15.7 20 8" />
    </Svg>
  ),
  Dimension: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 8v8M20 8v8M4 12h16" />
      <path d="m7 9.5-3 2.5 3 2.5M17 9.5l3 2.5-3 2.5" />
    </Svg>
  ),
  Construction: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 19 19 5" strokeDasharray="3 2.5" />
    </Svg>
  ),
  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Svg>
  ),
  Open: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 6h6l2 2h10v11H3z" />
      <path d="M3 10h18" />
    </Svg>
  ),
  Save: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M8 3v5h7V3M8 21v-7h8v7" />
    </Svg>
  ),
  New: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4M12 11v6M9 14h6" />
    </Svg>
  ),
  Assembly: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 3 13 5.8v5.6L8 14.2 3 11.4V5.8z" fill="currentColor" fillOpacity={0.15} />
      <path d="M16 9.8 21 12.6v5.6L16 21l-5-2.8v-5.6z" />
    </Svg>
  ),
  Pin: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 3h6l-1 6 3 3H7l3-3z" />
      <path d="M12 12v9" />
    </Svg>
  ),
  Insert: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Svg>
  ),
  List: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.6} />
    </Svg>
  ),
  MateFasten: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="8" height="16" rx="1" />
      <rect x="13" y="4" width="8" height="16" rx="1" />
      <path d="M9 12h6M12 9v6" />
    </Svg>
  ),
  MateRevolute: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4a8 8 0 1 1-7.4 5" />
      <path d="M4 5v4h4" />
    </Svg>
  ),
  MateSlider: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 15h18" />
      <rect x="7" y="8" width="8" height="5" rx="1" />
      <path d="M17 10.5h4M19 8.5l2 2-2 2" />
    </Svg>
  ),
  MateCylindrical: (p: IconProps) => (
    <Svg {...p}>
      <ellipse cx="12" cy="6" rx="4" ry="1.8" />
      <path d="M8 6v12c0 1 1.8 1.8 4 1.8s4-.8 4-1.8V6" />
      <path d="M12 2v20" strokeDasharray="2 2" />
    </Svg>
  ),
  MatePlanar: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 16 8 12h14l-6 4z" />
      <rect x="9" y="6" width="7" height="5" rx="1" />
    </Svg>
  ),
  MateBall: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="9" r="5" />
      <path d="M12 14v7M8 21h8" />
    </Svg>
  ),
  Drawing: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M13 15h7M13 17.5h7M13 15v5" />
      <rect x="6" y="7" width="5" height="4" />
    </Svg>
  ),
  Offset: (p: IconProps) => (
    <Svg {...p}>
      <rect x="7" y="7" width="10" height="10" rx="1" />
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" strokeDasharray="2.5 2" />
    </Svg>
  ),
  UseEdge: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 16 12 20l8-4V8l-8-4-8 4z" />
      <path d="M4 16 12 20l8-4" strokeWidth={2.6} />
    </Svg>
  ),
  Sweep: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 18c4 0 5-12 10-12h6" />
      <ellipse cx="4.5" cy="18" rx="1.6" ry="3" />
      <ellipse cx="19.5" cy="6" rx="1.6" ry="3" />
    </Svg>
  ),
  Loft: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="15" width="16" height="5" rx="0.5" />
      <ellipse cx="12" cy="5" rx="4" ry="1.6" />
      <path d="M4 15 8 5M20 15 16 5" />
    </Svg>
  ),
  Text: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 6V4h14v2M12 4v16M9 20h6" />
    </Svg>
  ),
};
