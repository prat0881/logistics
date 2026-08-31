import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        accent: "border-transparent bg-accent text-accent-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        pending: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

// forwardRef (S5.9 T10) — Radix's `Tooltip`/`Slot` asChild machinery clones its child with a
// composed ref so the popper can measure and anchor to it; a plain function component silently
// drops that ref (React logs "Function components cannot be given refs" and the anchor stays
// null). Originally added for `CompareLegPanel`'s decision-chip tooltip, which S5.9.1 removed —
// kept anyway (not reverted to a plain function component) since it's a general capability any
// future `asChild` consumer of `Badge` will need for free, and forwarding a ref costs nothing when
// unused.
export const Badge = forwardRef<HTMLDivElement, BadgeProps>(({ className, variant, ...props }, ref) => {
  return <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
});
Badge.displayName = "Badge";
