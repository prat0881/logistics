import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function MasterForm({
  title,
  error,
  banner,
  onSubmit,
  isSubmitting,
  onCancel,
  children,
}: {
  title: string;
  error?: string | null;
  banner?: ReactNode;
  onSubmit: () => void;
  isSubmitting: boolean;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      aria-label={title}
      className="max-w-3xl space-y-6"
    >
      <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {banner}
      {children}
      <div className="flex gap-2 border-t border-border pt-4">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
