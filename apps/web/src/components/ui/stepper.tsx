import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

export interface StepDef {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepDef[];
  current: string;
  completed: Set<string>;
  onStepClick?: (key: string) => void;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

const stepIndicatorVariants = cva(
  "flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium shrink-0 transition-colors",
  {
    variants: {
      state: {
        current: "bg-primary text-primary-foreground",
        completed: "bg-success text-success-foreground",
        upcoming: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { state: "upcoming" },
  },
);

type StepState = NonNullable<VariantProps<typeof stepIndicatorVariants>["state"]>;

function getStepState(
  key: string,
  current: string,
  completed: Set<string>,
): StepState {
  if (key === current) return "current";
  if (completed.has(key)) return "completed";
  return "upcoming";
}

export function Stepper({
  steps,
  current,
  completed,
  onStepClick,
  orientation = "horizontal",
  className,
}: StepperProps) {
  const isVertical = orientation === "vertical";

  return (
    <nav
      aria-label="Progress"
      className={cn(
        "flex",
        isVertical ? "flex-col gap-2" : "flex-row items-center gap-0",
        className,
      )}
    >
      {steps.map((step, index) => {
        const state = getStepState(step.key, current, completed);
        const isCurrent = state === "current";
        const isCompleted = state === "completed";
        const isClickable = !!onStepClick;

        return (
          <div
            key={step.key}
            className={cn(
              "flex",
              isVertical ? "flex-col items-start" : "flex-row items-center",
              !isVertical && "flex-1",
            )}
          >
            <button
              type="button"
              onClick={() => onStepClick?.(step.key)}
              disabled={!isClickable}
              aria-current={isCurrent ? "step" : undefined}
              data-completed={isCompleted ? "true" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-2 py-1 font-display text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:pointer-events-none",
                isClickable && "cursor-pointer hover:bg-muted",
                isCurrent && "text-primary font-semibold",
                isCompleted && "text-success",
                !isCurrent && !isCompleted && "text-muted-foreground",
              )}
            >
              <span className={stepIndicatorVariants({ state })}>
                {isCompleted ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true">{index + 1}</span>
                )}
              </span>
              <span>{step.label}</span>
            </button>

            {/* Connector line between steps */}
            {index < steps.length - 1 && (
              <div
                aria-hidden="true"
                className={cn(
                  "bg-border",
                  isVertical ? "ml-4 mt-1 mb-1 w-px h-4" : "flex-1 h-px mx-2",
                )}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
