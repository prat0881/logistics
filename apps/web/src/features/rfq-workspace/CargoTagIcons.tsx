import { Weight, Wine, Layers, TriangleAlert } from "lucide-react";
import type { CargoDto, ReferenceTag } from "@svyft/shared";

export function CargoTagIcons({ cargo }: { cargo: CargoDto[] }) {
  const has = (tag: ReferenceTag) => cargo.some((c) => c.referenceTags.includes(tag));
  const dg = cargo.some((c) => c.isDangerous);

  const items: { key: string; label: string; icon: React.ReactElement }[] = [];
  if (has("HEAVY")) items.push({ key: "HEAVY", label: "Heavy", icon: <Weight className="h-4 w-4" /> });
  if (has("FRAGILE")) items.push({ key: "FRAGILE", label: "Fragile", icon: <Wine className="h-4 w-4" /> });
  if (has("NON_STACKABLE")) items.push({ key: "NON_STACKABLE", label: "Non-stackable", icon: <Layers className="h-4 w-4" /> });
  if (dg) items.push({ key: "DG", label: "Dangerous goods", icon: <TriangleAlert className="h-4 w-4 text-warning" /> });

  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((it) => (
        <span key={it.key} title={it.label} aria-label={it.label} className="text-muted-foreground">
          {it.icon}
        </span>
      ))}
    </div>
  );
}
