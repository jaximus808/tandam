import { TandemLogo } from "web";

// The Tandem brand mark: a canvas (rounded square) with three dots orbiting a
// flat ring. Captured with `animate={false}` so each frame shows the steady
// state (the entrance animation is time-based and can't be shown in a still).

export function Logo() {
  return <TandemLogo size={96} animate={false} />;
}

export function Small() {
  return <TandemLogo size={40} animate={false} />;
}

export function Large() {
  return <TandemLogo size={160} animate={false} />;
}

export function InHeader() {
  return (
    <div className="flex items-center gap-2 bg-paper px-4 py-3 text-ink">
      <TandemLogo size={24} animate={false} />
      <span className="font-display text-lg font-semibold tracking-tight">Tandem</span>
    </div>
  );
}
