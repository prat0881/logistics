import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange" | "type"> & {
  value: number | null;
  onChange: (v: number | null) => void;
};

export const NumberField = forwardRef<HTMLInputElement, Props>(function NumberField(
  { value, onChange, className, ...rest }, ref,
) {
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      className={cn("font-mono tabular-nums", className)}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      {...rest}
    />
  );
});
