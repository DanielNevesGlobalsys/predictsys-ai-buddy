import { useEffect } from "react";

const FAVICON_HREF = "/favicon.svg?v=20260129";

function upsertFaviconLink(rel: "icon" | "shortcut icon", href: string) {
  let link = document.querySelector<HTMLLinkElement>(`link[rel='${rel}']`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;
}

/**
 * Enforce the correct favicon even when browsers cache old icons aggressively.
 */
export default function Favicon() {
  useEffect(() => {
    upsertFaviconLink("icon", FAVICON_HREF);
    upsertFaviconLink("shortcut icon", FAVICON_HREF);
  }, []);

  return null;
}
