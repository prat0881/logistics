import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A small, dependency-free radio-group primitive (no `@radix-ui/react-radio-group` in this
 * repo yet — S5.6 Task 4 needed one and the brief allows hand-rolling it). Mirrors Radix's own
 * `RadioGroup`/`RadioGroupItem` API shape (`value`/`onValueChange` on the group, a bare `value`
 * on each item) so a later swap to the real primitive is a drop-in, not a rewrite of every
 * caller. Built on native `<input type="radio">` so grouping/keyboard nav/`aria-checked` all
 * come from the browser for free — no manual ARIA roving-tabindex needed.
 */
interface RadioGroupContextValue {
  name: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  /** The shared `name` for the underlying native radio inputs — must be unique per group on the page. */
  name: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ className, name, value, onValueChange, children, ...props }, ref) => (
    <div ref={ref} role="radiogroup" className={cn("space-y-2", className)} {...props}>
      <RadioGroupContext.Provider value={{ name, value, onValueChange }}>
        {children}
      </RadioGroupContext.Provider>
    </div>
  ),
);
RadioGroup.displayName = "RadioGroup";

export interface RadioGroupItemProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value" | "name"> {
  value: string;
}

const RadioGroupItem = React.forwardRef<HTMLInputElement, RadioGroupItemProps>(
  ({ className, value, ...props }, ref) => {
    const ctx = React.useContext(RadioGroupContext);
    if (!ctx) throw new Error("RadioGroupItem must be rendered within a RadioGroup");
    return (
      <input
        ref={ref}
        type="radio"
        name={ctx.name}
        value={value}
        checked={ctx.value === value}
        onChange={() => ctx.onValueChange?.(value)}
        className={cn(
          "h-4 w-4 border border-primary text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
RadioGroupItem.displayName = "RadioGroupItem";

export { RadioGroup, RadioGroupItem };
