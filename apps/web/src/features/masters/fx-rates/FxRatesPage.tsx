import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  fxRateCreateSchema,
  CURRENCY_CODES,
  Role,
  viewerZone,
  formatInZone,
  type FxRateCreateInput,
} from "@svyft/shared";
import { useAuth } from "@/features/auth/AuthProvider";
import { useFxRatesList, useCreateFxRate } from "./useFxRates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form } from "@/components/ui/form";
import { ZonedDateTimeField } from "@/components/ZonedDateTimeField";

const CURRENCY_OPTIONS = CURRENCY_CODES.filter((c) => c !== "USD");
const selectClass =
  "h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export function FxRatesPage() {
  const { user } = useAuth();
  const canWrite = user?.role === Role.ADMINISTRATOR || user?.role === Role.MANAGER;
  const { data, isLoading } = useFxRatesList();
  const zone = viewerZone();

  return (
    <div className="space-y-6">
      <h1 className="font-display text-xl font-semibold tracking-tight">FX Rates</h1>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Currency</th>
                <th className="px-4 py-2 font-medium">Units/USD</th>
                <th className="px-4 py-2 font-medium">Effective from</th>
                <th className="px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {data?.length ? (
                data.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-medium">{r.currency}</td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">
                      {r.unitsPerUsd}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {formatInZone(r.effectiveFrom, zone)}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{r.note ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No FX rates yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && <AddRateForm zone={zone} />}
    </div>
  );
}

function AddRateForm({ zone }: { zone: string }) {
  const createRate = useCreateFxRate();
  const form = useForm<FxRateCreateInput>({
    resolver: zodResolver(fxRateCreateSchema),
  });
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = form;

  async function onSubmit(values: FxRateCreateInput) {
    await createRate.mutateAsync(values);
    reset();
  }

  const err = (name: keyof FxRateCreateInput) =>
    errors[name] ? (
      <p role="alert" className="text-sm text-destructive">
        {errors[name]?.message as string}
      </p>
    ) : null;

  return (
    <Form {...form}>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="max-w-md space-y-4 rounded-md border border-border bg-card p-4"
        aria-label="Add rate form"
      >
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Add rate
        </h2>

        <div className="space-y-1">
          <Label htmlFor="currency">Currency</Label>
          <select id="currency" {...register("currency")} className={selectClass}>
            <option value="">Select currency…</option>
            {CURRENCY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {err("currency")}
        </div>

        <div className="space-y-1">
          <Label htmlFor="unitsPerUsd">Units/USD</Label>
          <Input
            id="unitsPerUsd"
            type="number"
            step="any"
            {...register("unitsPerUsd", { valueAsNumber: true })}
          />
          {err("unitsPerUsd")}
        </div>

        <ZonedDateTimeField
          control={control}
          name="effectiveFrom"
          label="Effective from"
          zone={zone}
        />

        <div className="space-y-1">
          <Label htmlFor="note">Note</Label>
          <Input
            id="note"
            {...register("note", { setValueAs: (v: string) => (v === "" ? undefined : v) })}
          />
          {err("note")}
        </div>

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Add rate"}
        </Button>
      </form>
    </Form>
  );
}
