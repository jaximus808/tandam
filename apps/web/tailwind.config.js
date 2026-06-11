/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
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
      colors: {
        paper: "#FBFAF8",
        // Warm near-black — the "human" ink of the worksurface. Borders use
        // ink at low alpha (ink/10, ink/15) so hairlines stay warm, not gray.
        ink: "#1C1917",
        // The agent signature colour. Humans are ink, agents are terracotta —
        // every agent-authored thing on a surface carries this.
        agent: "#C75B39",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
