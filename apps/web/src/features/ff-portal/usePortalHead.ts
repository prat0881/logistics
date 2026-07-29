import { useEffect } from "react";

export function usePortalHead(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => {
      document.title = prev;
      meta.remove();
    };
  }, [title]);
}
