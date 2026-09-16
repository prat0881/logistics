import type { UseFormRegisterReturn } from "react-hook-form";
import { Field } from "./Field";

// The one place the master forms describe a <select>. Four files previously carried their own
// copy of this class string; changing focus rings meant changing four files.
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function SelectField({
  id,
  label,
  error,
  options,
  placeholder,
  registration,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  registration: UseFormRegisterReturn;
  className?: string;
}) {
  return (
    <Field id={id} label={label} error={error} className={className}>
      <select id={id} className={selectClass} {...registration}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
