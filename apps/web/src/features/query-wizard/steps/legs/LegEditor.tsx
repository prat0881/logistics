import { useState, useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  legSaveSchema,
  FREIGHT_MODES,
  checkModeEndpoints,
} from "@svyft/shared";
import type {
  LegSaveInput,
  QueryDetail,
  QueryPointDto,
  QueryLegDto,
  FreightMode,
  Finding,
} from "@svyft/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { toIsoOffset, isoToLocalInput } from "@/lib/dates";
import { useLegs } from "./useLegs";
import { PointEditor } from "./PointEditor";
import { CargoAssignmentControl } from "./CargoAssignmentControl";

interface LegEditorProps {
  open: boolean;
  /** When editing, pass the existing leg; omit for create. */
  leg?: QueryLegDto;
  /** Full query detail — needed for points list + cargo list. */
  detail: QueryDetail;
  queryId: string;
  onSaved: () => void;
  onClose: () => void;
}

/** Point option label: "<type> — <name/city>" */
function pointLabel(p: QueryPointDto): string {
  const name = p.name ?? p.city ?? p.id;
  return `${p.type} — ${name}`;
}

/**
 * LegEditor — create/edit dialog for a single Leg.
 *
 * Fields:
 *   - Origin / Destination: <Select> over detail.points + "+ New point" → <PointEditor>
 *   - Mode: <Select> over FREIGHT_MODES
 *   - Live V-M1 client-side check (non-blocking warning; server 422 is authoritative)
 *   - Assigned Cargo: <CargoAssignmentControl> (≥1 required)
 *   - Ready Date / Target Delivery: datetime-local using floating-wall-clock helpers
 *
 * On save: catches ApiError 422 → surfaces findings inside dialog (keeps it open).
 */
export function LegEditor({
  open,
  leg,
  detail,
  queryId,
  onSaved,
  onClose,
}: LegEditorProps) {
  const isEdit = Boolean(leg);
  const { add, update } = useLegs(queryId);

  const [serverFindings, setServerFindings] = useState<Finding[]>([]);
  const [showPointEditor, setShowPointEditor] = useState<"origin" | "destination" | null>(null);

  const defaultValues: LegSaveInput = {
    originPointId: leg?.originPointId ?? undefined,
    destinationPointId: leg?.destinationPointId ?? undefined,
    mode: leg?.mode ?? undefined,
    readyDate: leg?.readyDate ?? undefined,
    targetDelivery: leg?.targetDelivery ?? undefined,
    assignedCargoIds: leg?.assignedCargoIds ?? [],
  };

  const form = useForm<LegSaveInput>({
    resolver: zodResolver(legSaveSchema),
    defaultValues,
  });

  // Reset form when dialog re-opens with a different leg
  useEffect(() => {
    if (open) {
      setServerFindings([]);
      form.reset({
        originPointId: leg?.originPointId ?? undefined,
        destinationPointId: leg?.destinationPointId ?? undefined,
        mode: leg?.mode ?? undefined,
        readyDate: leg?.readyDate ?? undefined,
        targetDelivery: leg?.targetDelivery ?? undefined,
        assignedCargoIds: leg?.assignedCargoIds ?? [],
      });
    }
  }, [open, leg?.id]); // Only reset when dialog opens or the leg being edited changes

  // Watch fields for client-side V-M1 pre-check
  const watchedOriginId = form.watch("originPointId");
  const watchedDestId = form.watch("destinationPointId");
  const watchedMode = form.watch("mode");

  const originPoint = detail.points.find((p) => p.id === watchedOriginId);
  const destPoint = detail.points.find((p) => p.id === watchedDestId);

  // Client-side V-M1 warning (non-blocking)
  const showClientVm1Warning =
    watchedMode != null &&
    originPoint != null &&
    destPoint != null &&
    !checkModeEndpoints(
      watchedMode as FreightMode,
      originPoint.type as Parameters<typeof checkModeEndpoints>[1],
      destPoint.type as Parameters<typeof checkModeEndpoints>[2],
    );

  const handleSubmit = form.handleSubmit(async (data) => {
    setServerFindings([]);
    try {
      if (isEdit && leg) {
        await update(leg.id, data);
      } else {
        await add(data);
      }
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.findings?.length) {
        setServerFindings(err.findings);
        // Keep dialog open — do not call onClose()
      } else {
        throw err;
      }
    }
  });

  // When a new point is saved from PointEditor, select it in the relevant field
  const handlePointSaved = (
    role: "origin" | "destination",
    saved: Record<string, unknown>,
  ) => {
    const id = saved.id as string;
    if (role === "origin") {
      form.setValue("originPointId", id, { shouldValidate: true });
    } else {
      form.setValue("destinationPointId", id, { shouldValidate: true });
    }
    setShowPointEditor(null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit Leg" : "Add Leg"}</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Origin */}
              <FormField
                control={form.control}
                name="originPointId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Origin</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Select
                          value={field.value ?? ""}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Select origin point" />
                          </SelectTrigger>
                          <SelectContent>
                            {detail.points.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {pointLabel(p)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowPointEditor("origin")}
                      >
                        + New point
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Destination */}
              <FormField
                control={form.control}
                name="destinationPointId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Destination</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Select
                          value={field.value ?? ""}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Select destination point" />
                          </SelectTrigger>
                          <SelectContent>
                            {detail.points.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {pointLabel(p)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setShowPointEditor("destination")}
                      >
                        + New point
                      </Button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Mode */}
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mode</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select freight mode" />
                        </SelectTrigger>
                        <SelectContent>
                          {FREIGHT_MODES.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Client-side V-M1 warning */}
              {showClientVm1Warning && (
                <div
                  data-testid="vm1-client-warning"
                  className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800"
                >
                  <span className="font-mono font-semibold mr-2">V-M1</span>
                  {watchedMode === "AIR"
                    ? "An Air leg needs airport endpoints."
                    : watchedMode === "SEA"
                    ? "A Sea leg needs seaport endpoints."
                    : "Endpoint types are incompatible with the selected mode."}
                  {" "}This is a warning — you can save, but the server will block if the constraint is violated.
                </div>
              )}

              {/* Assigned Cargo */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Assigned Cargo</label>
                <Controller
                  control={form.control}
                  name="assignedCargoIds"
                  render={({ field }) => (
                    <CargoAssignmentControl
                      cargo={detail.cargo}
                      value={field.value ?? []}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>

              {/* Ready Date */}
              <FormField
                control={form.control}
                name="readyDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ready Date</FormLabel>
                    <FormControl>
                      <Input
                        type="datetime-local"
                        value={isoToLocalInput(field.value ?? null)}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v ? toIsoOffset(v) : undefined);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Target Delivery */}
              <FormField
                control={form.control}
                name="targetDelivery"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target Delivery</FormLabel>
                    <FormControl>
                      <Input
                        type="datetime-local"
                        value={isoToLocalInput(field.value ?? null)}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v ? toIsoOffset(v) : undefined);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Server-side findings (V-M1 422) */}
              {serverFindings.length > 0 && (
                <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 space-y-1">
                  {serverFindings.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-destructive text-sm">
                      <span className="font-mono font-semibold shrink-0">{f.rule}</span>
                      <span>{f.message}</span>
                    </div>
                  ))}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit">Save Leg</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Nested PointEditor for adding a new point inline */}
      {showPointEditor && (
        <PointEditor
          queryId={queryId}
          open={Boolean(showPointEditor)}
          onSaved={(saved) => handlePointSaved(showPointEditor, saved)}
          onClose={() => setShowPointEditor(null)}
        />
      )}
    </>
  );
}
