import type { MouseEvent } from "react";

/**
 * Wraps an in-app navigation callback so it can be attached to a real `<a href>`
 * instead of a `<button>`.
 *
 * Why this exists: the app routes by pushState, so every nav control was a
 * button. Buttons aren't links — crawlers never followed them, which left /mcp
 * and /about with no inbound internal link anywhere on the site (a sitemap gets
 * a URL discovered; a link is what tells a search engine the two pages are
 * related and worth ranking). Rendering them as anchors also gets us
 * middle-click and cmd-click "open in new tab" for free.
 *
 * Modified clicks and non-primary buttons fall through to the browser so those
 * still open a new tab; a plain left click is handled in-app.
 */
export function spaLink(navigate: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate();
  };
}
