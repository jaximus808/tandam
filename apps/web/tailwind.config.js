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
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
