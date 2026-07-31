// apps/web/src/components/ZonedDateTimeField.tsx
import type { Control, FieldValues, Path } from "react-hook-form";
import { zonedInputToUtc, utcToZonedInput, zoneLabel, noonTodayInZone } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";

interface Props<TFieldValues extends FieldValues = FieldValues> {
  control: Control<TFieldValues>;
  name: string;
  label: string;
  zone: string;
  required?: boolean;
  readOnly?: boolean;
  onChanged?: () => void;
  /**
   * When the field is empty, render a greyed 12:00 (noon-in-`zone`) hint in the box instead of
   * letting the browser draw its own empty-state placeholder (which some browsers render as a
   * sample "today, 12:30 PM"). This is DISPLAY-ONLY: `field.value` stays undefined, so the
   * field still submits blank until the user actually picks a time — the moment they edit, the
   * value becomes real and the muted styling drops. Used for optional fields (ETA/ETB/ETD).
   */
  placeholderNoon?: boolean;
}

export function ZonedDateTimeField<TFieldValues extends FieldValues = FieldValues>({
  control,
  name,
  label,
  zone,
  required,
  readOnly,
  onChanged,
  placeholderNoon,
}: Props<TFieldValues>) {
  return (
    <FormField
      control={control}
      name={name as Path<TFieldValues>}
      render={({ field }) => {
        // Ghost 12:00 shown only while the field is empty and `placeholderNoon` is set. It is
        // display-only — field.value remains undefined, so the field submits blank until the
        // user picks a time. Muted styling makes it read as a placeholder, not a set value.
        const showGhost = !field.value && !!placeholderNoon;
        const displayValue = field.value
          ? utcToZonedInput(field.value, zone)
          : showGhost
            ? utcToZonedInput(noonTodayInZone(zone), zone)
            : "";
        const className =
          [readOnly ? "bg-muted" : "", showGhost ? "text-muted-foreground" : ""]
            .filter(Boolean)
            .join(" ") || undefined;
        return (
          <FormItem>
            <FormLabel>
              {label}
              {required ? <span className="text-destructive"> *</span> : null}
            </FormLabel>
            <FormControl>
              <Input
                type="datetime-local"
                readOnly={readOnly}
                className={className}
                value={displayValue}
                onChange={(e) => {
                  let v = e.target.value;
                  const wasEmpty = !field.value;
                  if (v && wasEmpty) v = v.slice(0, 14) + "00"; // "YYYY-MM-DDTHH:" + "00"
                  field.onChange(v ? zonedInputToUtc(v, zone) : undefined);
                  onChanged?.();
                }}
              />
            </FormControl>
            <p className="text-xs text-muted-foreground">Times in {zone} ({zoneLabel(zone)})</p>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}
