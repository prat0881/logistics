// apps/web/src/components/ZonedDateTimeField.tsx
import type { Control, FieldValues, Path } from "react-hook-form";
import { zonedInputToUtc, utcToZonedInput, zoneLabel } from "@svyft/shared";
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
}

export function ZonedDateTimeField<TFieldValues extends FieldValues = FieldValues>({
  control,
  name,
  label,
  zone,
  required,
  readOnly,
  onChanged,
}: Props<TFieldValues>) {
  return (
    <FormField
      control={control}
      name={name as Path<TFieldValues>}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {label}
            {required ? <span className="text-destructive"> *</span> : null}
          </FormLabel>
          <FormControl>
            <Input
              type="datetime-local"
              readOnly={readOnly}
              className={readOnly ? "bg-muted" : undefined}
              value={utcToZonedInput(field.value ?? "", zone)}
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
      )}
    />
  );
}
