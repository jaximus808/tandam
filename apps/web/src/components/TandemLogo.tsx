interface Props {
  size?: number;
  animate?: boolean;
  className?: string;
}

// Orbiting logo: a central canvas (rounded square) with three small dots
// circling a flat orbit ring. Based on the v8 design — kept minimalist and
// flat. When `animate` is on, the orbit starts collapsed around the square
// and spinning fast, then expands outward and decelerates into a slow
// steady-state rotation.
export default function TandemLogo({ size = 64, animate = true, className = "" }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Orbit ring + dots both scale outward together. */}
      <g className={animate ? "tandem-orbit-expand" : undefined}>
        <circle
          cx="256"
          cy="256"
          r="150"
          fill="none"
          stroke="#38BDF8"
          strokeWidth="10"
          strokeOpacity="0.35"
        />
        <g className={animate ? "tandem-orbit-rotate" : undefined}>
          <circle cx="256" cy="106" r="34" fill="#38BDF8" />
          <circle cx="386" cy="331" r="34" fill="#38BDF8" />
          <circle cx="126" cy="331" r="34" fill="#38BDF8" />
        </g>
      </g>

      {/* Canvas sits above the ring/dots so the dots appear to emerge from it. */}
      <rect x="186" y="186" width="140" height="140" rx="22" fill="#38BDF8" />
    </svg>
  );
}
