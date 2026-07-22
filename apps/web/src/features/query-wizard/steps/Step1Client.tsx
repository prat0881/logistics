import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { querySaveSchema, PRIORITIES, Role } from "@svyft/shared";
import type { QuerySaveInput, ContactDto, QueryDetail, ClientDto } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { fetchJson } from "@/lib/api";
import { useWizard } from "../WizardContext";
import { useAuth } from "@/features/auth/AuthProvider";
import { toIsoOffset, isoToLocalInput } from "@/lib/dates";
import { ClientPicker } from "../pickers/ClientPicker";
import { VesselPicker } from "../pickers/VesselPicker";

/**
 * Contract for a step's save function registered with the wizard shell.
 *
 * A step MUST follow exactly one of two patterns — never both:
 *   1. Return the patch values → the shell calls PATCH /api/queries/:id with them.
 *   2. Self-persist (call patch internally) and return `undefined` → the shell skips
 *      its own PATCH, avoiding a double-write (Step 2 and Step 5 use this pattern).
 */
export interface StepSaveFn {
  (opts?: { enforceRequired?: boolean }): Promise<QuerySaveInput | void>;
}

/** Step-1 mandatory fields (the F1 subset this step owns) — enforced on Next (U5). */
const STEP1_REQUIRED: { field: keyof QuerySaveInput; label: string }[] = [
  { field: "clientId", label: "Client" },
  { field: "contactName", label: "Contact Name" },
  { field: "contactEmail", label: "Email" },
  { field: "contactPhone", label: "Phone" },
  { field: "readyDate", label: "Ready Date" },
  { field: "targetDelivery", label: "Target Delivery" },
];

interface Step1ClientProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Convert a QueryDetail into RHF default values for Step 1.
 * Dates are stored as offset ISO strings on the server; datetime-local inputs
 * need "yyyy-MM-ddTHH:mm". We use isoToLocalInput() for each date field.
 */
function fromDetail(detail: QueryDetail | undefined): Partial<QuerySaveInput> {
  if (!detail) return { priority: "MEDIUM" };
  return {
    priority: detail.priority ?? "MEDIUM",
    queryDate: detail.queryDate ? detail.queryDate : undefined,
    responseDeadline: detail.responseDeadline ?? undefined,
    responseDeadlineRemarks: detail.responseDeadlineRemarks ?? undefined,
    clientId: detail.clientId ?? undefined,
    contactName: detail.contactName ?? undefined,
    contactDesignation: detail.contactDesignation ?? undefined,
    contactEmail: detail.contactEmail ?? undefined,
    contactPhone: detail.contactPhone ?? undefined,
    whatsappEnabled: detail.whatsappEnabled ?? false,
    faxNumber: detail.faxNumber ?? undefined,
    vesselId: detail.vesselId ?? undefined,
    vesselName: detail.vesselName ?? undefined,
    imoNumber: detail.imoNumber ?? undefined,
    eta: detail.eta ?? undefined,
    etb: detail.etb ?? undefined,
    etd: detail.etd ?? undefined,
    portOfCall: detail.portOfCall ?? undefined,
    readyDate: detail.readyDate ?? undefined,
    targetDelivery: detail.targetDelivery ?? undefined,
  };
}

export function Step1Client({ registerSave }: Step1ClientProps) {
  const { detail } = useWizard();
  const { user } = useAuth();
  const isAdmin = user?.role === Role.ADMINISTRATOR;

  const [selectedClientId, setSelectedClientId] = useState<string | undefined>(
    detail?.clientId ?? undefined,
  );
  const [selectedClientName, setSelectedClientName] = useState<string | undefined>(
    undefined,
  );
  const [selectedVesselId, setSelectedVesselId] = useState<string | undefined>(
    detail?.vesselId ?? undefined,
  );
  const [selectedVesselName, setSelectedVesselName] = useState<string | undefined>(
    detail?.vesselName ?? undefined,
  );

  const form = useForm<QuerySaveInput>({
    resolver: zodResolver(querySaveSchema),
    defaultValues: fromDetail(detail),
  });

  // Reset form when detail loads/changes
  useEffect(() => {
    if (detail) {
      form.reset(fromDetail(detail));
      setSelectedClientId(detail.clientId ?? undefined);
      setSelectedVesselId(detail.vesselId ?? undefined);
      setSelectedVesselName(detail.vesselName ?? undefined);
    }
  }, [detail, form]);

  // When the wizard opens an existing query that already has a clientId, fetch the
  // client record so the picker trigger shows "Acme Corp" rather than the raw UUID.
  // Gated on selectedClientId being present AND selectedClientName not yet known
  // (e.g. the user hasn't picked a new client interactively this session).
  const { data: clientRecord } = useQuery({
    queryKey: ["client-detail", selectedClientId],
    queryFn: () => fetchJson<ClientDto>(`/api/clients/${selectedClientId}`),
    enabled: !!selectedClientId && !selectedClientName,
  });
  useEffect(() => {
    if (clientRecord?.companyName && !selectedClientName) {
      setSelectedClientName(clientRecord.companyName);
    }
  }, [clientRecord, selectedClientName]);

  // Load contacts when clientId is set
  const { data: contacts } = useQuery({
    queryKey: ["client-contacts", selectedClientId],
    queryFn: () => fetchJson<ContactDto[]>(`/api/clients/${selectedClientId}/contacts`),
    enabled: !!selectedClientId,
  });

  const submitRef = useRef<StepSaveFn>();

  useEffect(() => {
    submitRef.current = (opts) => {
      return new Promise<QuerySaveInput | void>((resolve, reject) => {
        const submitFn = form.handleSubmit(
          (values) => {
            // U5/D3: on advance (Next), this step's mandatory fields must be present.
            // Plain Save (no enforce) still persists a partial draft.
            if (opts?.enforceRequired) {
              const missing = STEP1_REQUIRED.filter(({ field }) => {
                const v = values[field];
                return v == null || (typeof v === "string" && v.trim() === "");
              });
              if (missing.length) {
                missing.forEach(({ field }) =>
                  form.setError(field, { type: "required", message: "Required to continue" }),
                );
                reject(
                  new Error(
                    "Complete these required fields before continuing: " +
                      missing.map((m) => m.label).join(", "),
                  ),
                );
                return;
              }
            }
            if (!isAdmin) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { queryDate: _, ...rest } = values;
              resolve(rest as typeof values);
            } else {
              resolve(values);
            }
          },
          // On format-validation error, reject so the shell surfaces it (the inline
          // FormMessages carry the per-field specifics).
          () => {
            reject(new Error("Please fix the highlighted fields."));
          },
        );
        // Call the handler and propagate any unexpected errors
        submitFn().catch(reject);
      });
    };
    registerSave((opts) => {
      if (submitRef.current) return submitRef.current(opts);
      return Promise.resolve();
    });
  }, [registerSave, form, isAdmin]);

  const handleContactSelect = (contactId: string) => {
    const contact = contacts?.find((c) => c.id === contactId);
    if (!contact) return;
    form.setValue("contactName", contact.name);
    form.setValue("contactDesignation", contact.designation ?? undefined);
    form.setValue("contactEmail", contact.email ?? undefined);
    form.setValue("contactPhone", contact.contactNo ?? undefined);
  };

  return (
    <Form {...form}>
      <form className="space-y-6 p-4">
        {/* Section: Query Details */}
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Query Details</h2>

          {/* Query ID (read-only) */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Query ID</label>
            <Input
              value={detail?.queryCode ?? "—"}
              readOnly
              className="font-mono bg-muted"
            />
          </div>

          {/* Query Date */}
          <FormField
            control={form.control}
            name="queryDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Query Date</FormLabel>
                <FormControl>
                  {isAdmin ? (
                    <Input
                      type="datetime-local"
                      value={isoToLocalInput(field.value ?? null)}
                      onChange={(e) => {
                        const v = e.target.value;
                        field.onChange(v ? toIsoOffset(v) : undefined);
                      }}
                    />
                  ) : (
                    <Input
                      value={isoToLocalInput(field.value ?? null)}
                      readOnly
                      className="bg-muted"
                    />
                  )}
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Priority */}
          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Priority</FormLabel>
                <Select
                  value={field.value ?? "MEDIUM"}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select priority" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Response Deadline */}
          <FormField
            control={form.control}
            name="responseDeadline"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Response Deadline</FormLabel>
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

          {/* Response Deadline Remarks */}
          <FormField
            control={form.control}
            name="responseDeadlineRemarks"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Response Deadline Remarks</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Remarks"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Section: Client & Contact */}
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Client &amp; Contact</h2>

          {/* Company / Client Picker */}
          <FormField
            control={form.control}
            name="clientId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company / Client</FormLabel>
                <FormControl>
                  <ClientPicker
                    value={
                      selectedClientId
                        ? { id: selectedClientId, companyName: selectedClientName ?? selectedClientId }
                        : null
                    }
                    onSelect={(c) => {
                      setSelectedClientId(c.id);
                      setSelectedClientName(c.companyName);
                      field.onChange(c.id);
                      // Clear contact fields when client changes
                      form.setValue("contactName", undefined);
                      form.setValue("contactDesignation", undefined);
                      form.setValue("contactEmail", undefined);
                      form.setValue("contactPhone", undefined);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Contact Person */}
          {contacts && contacts.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="contact-person-select" className="text-sm font-medium">
                Contact Person
              </label>
              <Select onValueChange={handleContactSelect}>
                <SelectTrigger id="contact-person-select" aria-label="Contact Person">
                  <SelectValue placeholder="Select contact…" />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Contact Name */}
          <FormField
            control={form.control}
            name="contactName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contact Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Contact name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Contact Designation */}
          <FormField
            control={form.control}
            name="contactDesignation"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Designation</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Designation"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Contact Email */}
          <FormField
            control={form.control}
            name="contactEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    value={field.value ?? ""}
                    placeholder="email@example.com"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Contact Phone */}
          <FormField
            control={form.control}
            name="contactPhone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone (E.164)</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="+6591234567"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* WhatsApp */}
          <FormField
            control={form.control}
            name="whatsappEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value ?? false}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="cursor-pointer">WhatsApp enabled</FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Fax */}
          <FormField
            control={form.control}
            name="faxNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Fax</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Fax number"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Section: Vessel & Schedule */}
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Vessel &amp; Schedule</h2>

          {/* Vessel Picker */}
          <FormField
            control={form.control}
            name="vesselId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vessel</FormLabel>
                <FormControl>
                  <VesselPicker
                    value={
                      selectedVesselId
                        ? { id: selectedVesselId, name: selectedVesselName ?? selectedVesselId }
                        : null
                    }
                    onSelect={(v) => {
                      setSelectedVesselId(v.id);
                      setSelectedVesselName(v.name);
                      field.onChange(v.id);
                      form.setValue("vesselName", v.name);
                      form.setValue("imoNumber", v.imoNumber ?? undefined);
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Vessel Name */}
          <FormField
            control={form.control}
            name="vesselName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Vessel Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Vessel name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* IMO Number */}
          <FormField
            control={form.control}
            name="imoNumber"
            render={({ field }) => (
              <FormItem>
                <FormLabel>IMO Number</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="1234567"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* ETA */}
          <FormField
            control={form.control}
            name="eta"
            render={({ field }) => (
              <FormItem>
                <FormLabel>ETA</FormLabel>
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

          {/* ETB */}
          <FormField
            control={form.control}
            name="etb"
            render={({ field }) => (
              <FormItem>
                <FormLabel>ETB</FormLabel>
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

          {/* ETD */}
          <FormField
            control={form.control}
            name="etd"
            render={({ field }) => (
              <FormItem>
                <FormLabel>ETD</FormLabel>
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

          {/* Port of Call */}
          <FormField
            control={form.control}
            name="portOfCall"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Port of Call</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value ?? ""}
                    placeholder="Port of call"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Section: Delivery */}
        <div className="space-y-4">
          <h2 className="text-base font-semibold">Delivery</h2>

          {/* Ready Date */}
          <FormField
            control={form.control}
            name="readyDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Ready Date <span className="text-destructive">*</span>
                </FormLabel>
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
                <FormLabel>
                  Target Delivery <span className="text-destructive">*</span>
                </FormLabel>
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
        </div>
      </form>
    </Form>
  );
}
