import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7891",
      "/canvas-images": "http://localhost:7891",
      "/ws": {
        target: "ws://localhost:7891",
        ws: true,
      },
    },
  },
});
