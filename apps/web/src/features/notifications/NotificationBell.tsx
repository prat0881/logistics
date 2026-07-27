import { useState, useRef, useEffect } from "react";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useNotifications } from "./useNotifications";
import type { NotificationDto } from "@svyft/shared";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { unreadCount, list, markRead } = useNotifications();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Refetch the list whenever the panel opens
  useEffect(() => {
    if (open) {
      void list.refetch();
    }
  }, [open, list.refetch]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleItemClick(item: NotificationDto) {
    markRead.mutate(item.id);
    if (item.queryId) {
      void navigate(`/queries/${item.queryId}`);
    }
    setOpen(false);
  }

  const items: NotificationDto[] = list.data ?? [];

  return (
    <div className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label="Notifications"
        onClick={() => setOpen((prev) => !prev)}
        className="relative"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-destructive-foreground">
            {unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border bg-popover shadow-md"
        >
          <div className="border-b px-3 py-2">
            <span className="text-sm font-semibold text-popover-foreground">
              Notifications
            </span>
          </div>

          {list.isLoading && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              Loading…
            </div>
          )}

          {!list.isLoading && items.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No notifications
            </div>
          )}

          {!list.isLoading && items.length > 0 && (
            <ul className="max-h-72 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => handleItemClick(item)}
                    className="w-full cursor-pointer px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                  >
                    <p
                      className={
                        item.readAt == null
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      {item.message}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {relativeTime(item.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
