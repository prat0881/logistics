import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { querySaveSchema, INCOTERMS } from "@svyft/shared";
import type { QuerySaveInput, QueryDetail } from "@svyft/shared";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useWizard } from "../WizardContext";
import { useSaveQuery } from "../useQueryDetail";
import type { StepSaveFn } from "./Step1Client";

interface Step2ShipmentProps {
  registerSave: (fn: StepSaveFn) => void;
}

function fromDetail(detail: QueryDetail | undefined): Partial<QuerySaveInput> {
  if (!detail) return {};
  return {
    incoterms: (detail.incoterms as QuerySaveInput["incoterms"]) ?? undefined,
    shipmentDescription: detail.shipmentDescription ?? undefined,
    dgIndicator: detail.dgIndicator ?? false,
  };
}

export function Step2Shipment({ registerSave }: Step2ShipmentProps) {
  const { detail, queryId } = useWizard();
  const { patch } = useSaveQuery();

  const form = useForm<QuerySaveInput>({
    resolver: zodResolver(querySaveSchema),
    defaultValues: fromDetail(detail),
  });

  // Reset form when detail loads/changes
  useEffect(() => {
    if (detail) {
      form.reset(fromDetail(detail));
    }
  }, [detail, form]);

  const submitRef = useRef<() => Promise<QuerySaveInput | void>>();

  useEffect(() => {
    submitRef.current = () => {
      return new Promise<QuerySaveInput | void>((resolve, reject) => {
        // Build the subset we care about from current form values
        const values = form.getValues();
        const payload: Partial<QuerySaveInput> = {
          incoterms: values.incoterms,
          shipmentDescription: values.shipmentDescription,
          dgIndicator: values.dgIndicator ?? false,
        };

        if (!queryId) {
          // Defensive guard: Step 2 should not be reachable before the query exists,
          // but return payload anyway so the shell can decide.
          resolve(payload as QuerySaveInput);
          return;
        }

        // Self-persist: Step 2 patches directly, then resolves undefined so the shell
        // skips its own PATCH (returning values would cause a double-write).
        patch(queryId, payload as QuerySaveInput)
          .then(() => resolve(undefined))
          .catch(reject);
      });
    };

    registerSave(async () => {
      if (submitRef.current) return submitRef.current();
    });
  }, [registerSave, form, queryId, patch]);

  const descriptionValue = form.watch("shipmentDescription") ?? "";
  const charCount = descriptionValue.length;

  return (
    <Form {...form}>
      <form className="space-y-6 p-4">
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Shipment Details</h2>

          {/* Incoterms */}
          <FormField
            control={form.control}
            name="incoterms"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Incoterms <span className="text-destructive">*</span>
                </FormLabel>
                <Select
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger aria-label="Incoterms">
                      <SelectValue placeholder="Select incoterms" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {INCOTERMS.map((term) => (
                      <SelectItem key={term} value={term}>
                        {term}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Shipment Description */}
          <FormField
            control={form.control}
            name="shipmentDescription"
            render={({ field }) => (
              <FormItem>
                <FormLabel htmlFor="shipmentDescription">Shipment Description</FormLabel>
                <FormControl>
                  <Textarea
                    id="shipmentDescription"
                    {...field}
                    value={field.value ?? ""}
                    maxLength={200}
                    placeholder="Describe the shipment…"
                    aria-label="Shipment Description"
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground text-right">
                  {charCount}/200
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* DG Indicator */}
          <FormField
            control={form.control}
            name="dgIndicator"
            render={({ field }) => (
              <FormItem className="space-y-1">
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Checkbox
                      id="dgIndicator"
                      checked={field.value ?? false}
                      onCheckedChange={field.onChange}
                      aria-label="DG Indicator"
                    />
                  </FormControl>
                  <FormLabel htmlFor="dgIndicator" className="cursor-pointer">
                    DG Indicator
                  </FormLabel>
                </div>
                <p className="text-xs text-muted-foreground pl-6">
                  Set automatically when a cargo row is dangerous; you can also set it manually.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </form>
    </Form>
  );
}
