/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // Class strategy: a `.dark` class on <html> drives the theme. The class is set
  // (before first paint) by the boot script in index.html + lib/theme.ts, which
  // default to the OS `prefers-color-scheme` and honor a saved override.
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // Inter (variable) is the ONE UI + display face (Design v2). Headings
        // are Inter at tight tracking and 600 weight — no display serif.
        sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        // JetBrains Mono — strictly machine text: tickets (TDM-n), commit
        // hashes, terminal content, canvas codes, keyboard hints. Never for
        // labels, eyebrows, or nav.
        code: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      // Semantic tokens are driven by CSS variables (channels defined in
      // index.css) so `.dark` can flip them without touching markup. The
      // `<alpha-value>` placeholder keeps `ink/10`, `paper/85`, etc. working —
      // e.g. `border-ink/10` resolves to `rgb(var(--color-ink) / 0.1)`, which in
      // dark mode is a warm off-white hairline instead of a dark one. Light-mode
      // values are unchanged, so light renders byte-identical to before.
      colors: {
        // Page background.
        paper: "rgb(var(--color-paper) / <alpha-value>)",
        // Card / panel surface — white in light, elevated near-black in dark.
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        // Cool near-black text in light; cool off-white in dark. Borders use ink
        // at low alpha (ink/10, ink/15) so hairlines flip with the theme.
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        // The single interactive hue (indigo): primary buttons, links, focus
        // rings, active nav, selected states. The only saturated colour allowed
        // outside semantic state chips + agent presence.
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        // The agent-presence signature (muted terracotta). Strictly presence
        // chips / cursors / attribution — never a ground, heading, or CTA.
        agent: "rgb(var(--color-agent) / <alpha-value>)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
