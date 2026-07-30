import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { querySaveSchema, INCOTERMS, incotermsLabel } from "@svyft/shared";
import type { QuerySaveInput, QueryDetail } from "@svyft/shared";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
    incoterms: (detail.incoterms as QuerySaveInput["incoterms"]) ?? "NA",
    shipmentDescription: detail.shipmentDescription ?? undefined,
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

  const submitRef = useRef<StepSaveFn>();

  useEffect(() => {
    submitRef.current = async () => {
      // G1: validate the fields this step owns before persisting. Previously Step 2
      // read raw form values and PATCHed with no client-side validation at all.
      const valid = await form.trigger(["incoterms", "shipmentDescription"]);
      if (!valid) {
        throw new Error("Please fix the highlighted fields.");
      }
      const values = form.getValues();
      const payload: Partial<QuerySaveInput> = {
        incoterms: values.incoterms,
        shipmentDescription: values.shipmentDescription,
      };

      if (!queryId) {
        // Defensive guard: Step 2 should not be reachable before the query exists,
        // but return payload anyway so the shell can decide.
        return payload as QuerySaveInput;
      }

      // Self-persist: Step 2 patches directly, then resolves undefined so the shell
      // skips its own PATCH (returning values would cause a double-write).
      await patch(queryId, payload as QuerySaveInput);
      return undefined;
    };

    registerSave(() => {
      if (submitRef.current) return submitRef.current();
      return Promise.resolve();
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
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {INCOTERMS.map((term) => (
                      <SelectItem key={term} value={term}>
                        {incotermsLabel(term)}
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

        </div>
      </form>
    </Form>
  );
}
