import { Weight, Wine, Layers, Ruler, TriangleAlert } from "lucide-react";
import { REFERENCE_TAGS, referenceTagLabel, type ReferenceTag } from "@svyft/shared";
import { cn } from "@/lib/utils";

const TAG_ICON: Record<ReferenceTag, React.ReactElement> = {
  HEAVY: <Weight className="h-4 w-4" />,
  FRAGILE: <Wine className="h-4 w-4" />,
  NON_STACKABLE: <Layers className="h-4 w-4" />,
  OUT_OF_GAUGE: <Ruler className="h-4 w-4" />,
  DG: <TriangleAlert className="h-4 w-4 text-warning" />,
};

export function ReferenceTagIcons({
  tags,
  className,
}: {
  tags: readonly ReferenceTag[];
  className?: string;
}): React.ReactElement | null {
  const items: { key: string; label: string; icon: React.ReactElement }[] = [];
  for (const tag of REFERENCE_TAGS) {
    if (tags.includes(tag))
      items.push({ key: tag, label: referenceTagLabel(tag), icon: TAG_ICON[tag] });
  }

  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {items.map((it) => (
        <span key={it.key} title={it.label} aria-label={it.label} className="text-muted-foreground">
          {it.icon}
        </span>
      ))}
    </div>
  );
}
