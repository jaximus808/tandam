import posthog from "posthog-js";

const key = (import.meta.env as Record<string, string | undefined>).VITE_POSTHOG_KEY;
const host = (import.meta.env as Record<string, string | undefined>).VITE_POSTHOG_HOST;

if (key) {
  posthog.init(key, {
    api_host: host ?? "https://us.i.posthog.com",
    defaults: "2026-05-30",
  });
}

export default posthog;
