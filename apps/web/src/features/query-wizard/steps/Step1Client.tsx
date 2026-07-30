import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { querySaveSchema, PRIORITIES, Role, defaultResponseDeadline, utcToZonedInput, zonedInputToUtc, noonTodayInZone } from "@svyft/shared";
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
import { useOrgTimezone } from "@/features/config/useOrgTimezone";
import { resolveQueryFieldZone } from "@/lib/zones";
import { ZonedDateTimeField } from "@/components/ZonedDateTimeField";
import { TimezoneCombobox } from "@/components/TimezoneCombobox";
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
  (): Promise<QuerySaveInput | void>;
}

interface Step1ClientProps {
  registerSave: (fn: StepSaveFn) => void;
}

/**
 * Convert a QueryDetail into RHF default values for Step 1.
 * Dates are stored as UTC ISO strings on the server and are passed directly
 * to ZonedDateTimeField, which projects them into the appropriate IANA zone.
 */
function fromDetail(detail: QueryDetail | undefined): Partial<QuerySaveInput> {
  if (!detail) return { priority: "MEDIUM", queryDate: new Date().toISOString() };
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
    readyDateTimezone: detail.readyDateTimezone ?? undefined,
    targetDeliveryTimezone: detail.targetDeliveryTimezone ?? undefined,
  };
}

export function Step1Client({ registerSave }: Step1ClientProps) {
  const { detail } = useWizard();
  const { user } = useAuth();
  const isAdmin = user?.role === Role.ADMINISTRATOR;

  const { orgZone, isLoading } = useOrgTimezone();

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
    defaultValues: {
      ...fromDetail(detail),
    },
  });

  const watchedReadyTz = form.watch("readyDateTimezone");
  const watchedTargetTz = form.watch("targetDeliveryTimezone");
  const graph = {
    points: detail?.points ?? [],
    legs: detail?.legs ?? [],
    readyDateTimezone: watchedReadyTz,
    targetDeliveryTimezone: watchedTargetTz,
  };
  const zoneFor = (f: Parameters<typeof resolveQueryFieldZone>[0]) =>
    resolveQueryFieldZone(f, graph, orgZone);

  // Tracks whether the exec has manually edited the Response Deadline field.
  // When false, the field is recomputed from queryDate + priority on every priority change.
  const deadlineTouchedRef = useRef(false);

  // Reset the form when a query detail loads/changes. Deps do NOT include orgZone, so a
  // late-resolving org-timezone fetch can never re-trigger a full-form reset (which would
  // clobber the exec's un-saved edits).
  useEffect(() => {
    if (!detail) return;
    form.reset({ ...fromDetail(detail) });
    setSelectedClientId(detail.clientId ?? undefined);
    setSelectedVesselId(detail.vesselId ?? undefined);
    setSelectedVesselName(detail.vesselName ?? undefined);
    // If the loaded detail already has a deadline, treat it as "touched" so we
    // don't overwrite the server-persisted value.
    if (detail.responseDeadline) {
      deadlineTouchedRef.current = true;
    }
  }, [detail, form]);

  // Seed the timezone fields to the real org zone once known, only when still empty.
  // Declared AFTER the reset effect so on the initial flush it runs after reset (not wiped).
  // Empty-guarded → never clobbers a stored zone or a user pick. Re-runs when the fetch
  // resolves (orgZone/isLoading change) WITHOUT resetting any other field.
  useEffect(() => {
    if (isLoading || !orgZone) return;
    if (!form.getValues("readyDateTimezone")) form.setValue("readyDateTimezone", orgZone);
    if (!form.getValues("targetDeliveryTimezone")) form.setValue("targetDeliveryTimezone", orgZone);
  }, [detail, isLoading, orgZone, form]);

  // Auto-default Response Deadline = queryDate + priority-hours (recompute until touched).
  // Minutes are zeroed in the org zone so the displayed wall-clock shows :00 (not :30 in IST).
  const watchedPriority = form.watch("priority");
  const watchedQueryDate = form.watch("queryDate");
  useEffect(() => {
    if (deadlineTouchedRef.current) return;
    if (!watchedQueryDate || !watchedPriority) return;
    if (!orgZone) return;
    const rdUtc = defaultResponseDeadline(watchedQueryDate, watchedPriority);
    const zeroed = zonedInputToUtc(utcToZonedInput(rdUtc, orgZone).slice(0, 14) + "00", orgZone);
    form.setValue("responseDeadline", zeroed);
  }, [watchedPriority, watchedQueryDate, orgZone, form]);

  // Seed Target Pickup + Target Delivery for a NEW query so the wizard opens on a clean
  // 12:00 (:00) default in the org zone, instead of the native datetime-local placeholder —
  // which reads as "12:30" once an empty (UTC-anchored) instant is projected into IST (the
  // bug users hit). On a new query there are no points yet, so both anchor to the org zone
  // (see resolveQueryFieldZone). Seed once, only empty fields, and never on an existing query
  // (detail present) so an intentionally-blank date is never back-filled. G10 compares with
  // <=, so seeding both to the same noon is valid. Minutes are :00 but stay editable.
  //
  // ETA/ETB/ETD are deliberately EXCLUDED: F3 requires ETA < ETB < ETD (strict), so defaulting
  // all three to the same noon would fail validation on every query. They stay empty until the
  // user enters real, ordered vessel times.
  const dateSeededRef = useRef(false);
  useEffect(() => {
    if (detail) return;
    if (isLoading || !orgZone) return;
    if (dateSeededRef.current) return;
    dateSeededRef.current = true;
    const noon = noonTodayInZone(orgZone);
    for (const f of ["readyDate", "targetDelivery"] as const) {
      if (!form.getValues(f)) form.setValue(f, noon);
    }
  }, [detail, isLoading, orgZone, form]);

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
    submitRef.current = () => {
      return new Promise<QuerySaveInput | void>((resolve, reject) => {
        const submitFn = form.handleSubmit(
          (values) => {
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
    registerSave(() => {
      if (submitRef.current) return submitRef.current();
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
      <form className="space-y-5 p-4">
        {/* Section: Query Details */}
        <div>
          <h2 className="text-base font-semibold mb-4">Query Details</h2>

          {/* Query ID (read-only) — full width */}
          <div className="mb-4 space-y-2">
            <label className="text-sm font-medium">Query ID</label>
            <Input
              value={detail?.queryCode ?? "—"}
              readOnly
              className="font-mono bg-muted"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Query Date */}
            <ZonedDateTimeField
              control={form.control}
              name="queryDate"
              label="Query Date"
              zone={zoneFor("queryDate")}
              readOnly={!isAdmin}
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
            <ZonedDateTimeField
              control={form.control}
              name="responseDeadline"
              label="Response Deadline"
              zone={zoneFor("responseDeadline")}
              onChanged={() => { deadlineTouchedRef.current = true; }}
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
        </div>

        {/* Section: Client & Contact */}
        <div>
          <h2 className="text-base font-semibold mb-4">Client &amp; Contact</h2>

          {/* Company / Client Picker — full width */}
          <div className="mb-4">
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
          </div>

          {/* Contact Person — full width, only when contacts exist */}
          {contacts && contacts.length > 0 && (
            <div className="mb-4 space-y-2">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        </div>

        {/* Section: Vessel & Schedule */}
        <div>
          <h2 className="text-base font-semibold mb-4">Vessel &amp; Schedule</h2>

          {/* Vessel Picker — full width */}
          <div className="mb-4">
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
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <ZonedDateTimeField
              control={form.control}
              name="eta"
              label="ETA"
              zone={zoneFor("eta")}
            />

            {/* ETB */}
            <ZonedDateTimeField
              control={form.control}
              name="etb"
              label="ETB"
              zone={zoneFor("etb")}
            />

            {/* ETD */}
            <ZonedDateTimeField
              control={form.control}
              name="etd"
              label="ETD"
              zone={zoneFor("etd")}
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
        </div>

        {/* Section: Delivery */}
        <div>
          <h2 className="text-base font-semibold mb-4">Shipment Dates</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Ready Date */}
            <ZonedDateTimeField
              control={form.control}
              name="readyDate"
              label="Target Pickup"
              zone={zoneFor("readyDate")}
              required
            />
            <FormField
              control={form.control}
              name="readyDateTimezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Target Pickup timezone</FormLabel>
                  <FormControl>
                    <TimezoneCombobox
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      ariaLabel="Target Pickup timezone"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Target Delivery */}
            <ZonedDateTimeField
              control={form.control}
              name="targetDelivery"
              label="Target Delivery"
              zone={zoneFor("targetDelivery")}
              required
            />
            <FormField
              control={form.control}
              name="targetDeliveryTimezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Target Delivery timezone</FormLabel>
                  <FormControl>
                    <TimezoneCombobox
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      ariaLabel="Target Delivery timezone"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      </form>
    </Form>
  );
}
