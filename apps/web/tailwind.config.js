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
        // Hanken Grotesk is the workhorse UI/body face — also the default sans
        // so the whole app inherits it without every element opting in.
        sans: ['"Hanken Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
        brand: ['"Hanken Grotesk"', "ui-sans-serif", "system-ui", "sans-serif"],
        // Fraunces — the editorial display face for titles and canvas names.
        display: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        // JetBrains Mono — codes, technical labels, anything monospaced.
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
        // Warm near-black text in light; warm off-white in dark. Borders use ink
        // at low alpha (ink/10, ink/15) so hairlines flip with the theme.
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        // The agent signature colour. Humans are ink, agents are terracotta —
        // every agent-authored thing on a surface carries this.
        agent: "rgb(var(--color-agent) / <alpha-value>)",
        // The Tandem brand teal — the mark's colour (see TandemLogo). Used for
        // neutral brand accents that shouldn't read as "agent" terracotta.
        brand: "rgb(var(--color-brand) / <alpha-value>)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
