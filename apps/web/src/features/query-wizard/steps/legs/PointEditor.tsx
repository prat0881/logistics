import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  pointSaveSchema,
  pointUpdateSchema,
  POINT_TYPES,
  WAREHOUSE_TYPES,
  POINT_REQUIRED_FIELDS,
} from "@svyft/shared";
import type {
  PointSaveInput,
  PointUpdateInput,
  PointType,
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
import { usePoints } from "./usePoints";

/** Existing point row shape (from API / query detail). */
interface PointRow {
  id: string;
  type: PointType;
  name?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  warehouseType?: string | null;
  iataCode?: string | null;
  icaoCode?: string | null;
  unLocode?: string | null;
  terminal?: string | null;
}

interface PointEditorProps {
  queryId: string;
  open: boolean;
  /** Pre-select a type (only applies on create; disabled when editing). */
  type?: PointType;
  /** When editing an existing point, pass the full point row. */
  point?: PointRow;
  onSaved: (point: Record<string, unknown>) => void;
  onClose: () => void;
}

/**
 * Required-field marker for display purposes only.
 * Reads POINT_REQUIRED_FIELDS[type] — does not add runtime validation.
 */
function RequiredMark({
  field,
  type,
}: {
  field: keyof PointSaveInput;
  type: PointType;
}) {
  const required = POINT_REQUIRED_FIELDS[type] as (keyof PointSaveInput)[];
  return required.includes(field) ? (
    <span className="text-destructive"> *</span>
  ) : null;
}

/**
 * PointEditor — type-aware create/edit dialog for a single Point.
 *
 * Field visibility by type (spec §7.4.1):
 *   PICKUP/DELIVERY  → name, streetAddress, city, postalCode, country, contactName, contactPhone, contactEmail
 *   WAREHOUSE        → name, streetAddress, city, postalCode, country, warehouseType, optional contacts
 *   AIRPORT          → name, iataCode, icaoCode(opt), terminal(opt), city, postalCode, country, optional contacts
 *   SEAPORT          → name, unLocode, terminal(opt), city, postalCode, country, optional contacts
 *
 * Validation is fully schema-driven via zodResolver(pointSaveSchema / pointUpdateSchema).
 * IATA ^[A-Z]{3}$, ICAO ^[A-Z]{4}$, UN-LOCODE ^[A-Z]{2}[A-Z0-9]{3}$ are enforced by the
 * shared schema. Save does NOT hard-block on per-type required fields (partial drafts allowed, D8).
 */
export function PointEditor({
  queryId,
  open,
  type: typeProp,
  point,
  onSaved,
  onClose,
}: PointEditorProps) {
  const isEdit = Boolean(point);
  const { add, update, remove } = usePoints(queryId);

  // Local controlled state for type (when creating a new point).
  const [selectedType, setSelectedType] = useState<PointType>(
    (point?.type ?? typeProp ?? "PICKUP") as PointType,
  );

  const activeType = isEdit ? (point!.type as PointType) : selectedType;

  const form = useForm<PointSaveInput | PointUpdateInput>({
    resolver: zodResolver(isEdit ? pointUpdateSchema : pointSaveSchema),
    defaultValues: point
      ? {
          type: point.type,
          name: point.name ?? undefined,
          streetAddress: point.streetAddress ?? undefined,
          city: point.city ?? undefined,
          postalCode: point.postalCode ?? undefined,
          country: point.country ?? undefined,
          contactName: point.contactName ?? undefined,
          contactPhone: point.contactPhone ?? undefined,
          contactEmail: point.contactEmail ?? undefined,
          warehouseType: (point.warehouseType as PointSaveInput["warehouseType"]) ?? undefined,
          iataCode: point.iataCode ?? undefined,
          icaoCode: point.icaoCode ?? undefined,
          unLocode: point.unLocode ?? undefined,
          terminal: point.terminal ?? undefined,
        }
      : {
          type: typeProp ?? "PICKUP",
        },
  });

  const handleTypeChange = (t: string) => {
    setSelectedType(t as PointType);
    form.setValue("type", t as PointType);
  };

  const handleDelete = async () => {
    if (!point || !window.confirm("Delete this point?")) return;
    await remove(point.id);
    onSaved(point as unknown as Record<string, unknown>);
    onClose();
  };

  const handleSubmit = form.handleSubmit(async (data) => {
    let saved: Record<string, unknown>;
    if (isEdit) {
      saved = await update(point!.id, data as PointUpdateInput);
    } else {
      // Always send type for create
      saved = await add({ ...data, type: activeType } as PointSaveInput);
    }
    onSaved(saved);
    onClose();
  });

  // Determine which field groups to render based on active type
  const showStreetAddress = activeType === "PICKUP" || activeType === "DELIVERY" || activeType === "WAREHOUSE";
  const showWarehouseType = activeType === "WAREHOUSE";
  const showIataCode = activeType === "AIRPORT";
  const showIcaoCode = activeType === "AIRPORT";
  const showTerminal = activeType === "AIRPORT" || activeType === "SEAPORT";
  const showUnLocode = activeType === "SEAPORT";
  const showContacts = activeType === "PICKUP" || activeType === "DELIVERY" || activeType === "WAREHOUSE";
  const showOptionalContacts = activeType === "AIRPORT" || activeType === "SEAPORT";

  const typeLabel: Record<PointType, string> = {
    PICKUP: "Pickup",
    DELIVERY: "Delivery",
    WAREHOUSE: "Warehouse",
    AIRPORT: "Airport",
    SEAPORT: "Seaport",
  };

  const namePlaceholderMap: Record<PointType, string> = {
    PICKUP: "Company / sender name",
    DELIVERY: "Company / receiver name",
    WAREHOUSE: "Warehouse name",
    AIRPORT: "Airport name",
    SEAPORT: "Port name",
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${typeLabel[activeType]}` : "Add Point"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type selector — disabled when editing */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Type <span className="text-destructive">*</span>
              </label>
              <Select
                value={activeType}
                onValueChange={handleTypeChange}
                disabled={isEdit}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {POINT_TYPES.map((pt) => (
                    <SelectItem key={pt} value={pt}>
                      {typeLabel[pt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Name
                    <RequiredMark field="name" type={activeType} />
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder={namePlaceholderMap[activeType]}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Street Address (PICKUP / DELIVERY / WAREHOUSE only) */}
            {showStreetAddress && (
              <FormField
                control={form.control}
                name="streetAddress"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Street Address
                      <RequiredMark field="streetAddress" type={activeType} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="123 Main St"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* IATA Code (AIRPORT only) */}
            {showIataCode && (
              <FormField
                control={form.control}
                name="iataCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      IATA Code
                      <RequiredMark field="iataCode" type={activeType} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        placeholder="LHR"
                        maxLength={3}
                        className="font-mono uppercase"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* ICAO Code (AIRPORT only — optional) */}
            {showIcaoCode && (
              <FormField
                control={form.control}
                name="icaoCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>ICAO Code</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        placeholder="EGLL"
                        maxLength={4}
                        className="font-mono uppercase"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* UN/LOCODE (SEAPORT only) */}
            {showUnLocode && (
              <FormField
                control={form.control}
                name="unLocode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      UN/LOCODE
                      <RequiredMark field="unLocode" type={activeType} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        placeholder="GBFXT"
                        maxLength={5}
                        className="font-mono uppercase"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Terminal (AIRPORT / SEAPORT — optional) */}
            {showTerminal && (
              <FormField
                control={form.control}
                name="terminal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Terminal</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="Terminal 5"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Warehouse Type (WAREHOUSE only) */}
            {showWarehouseType && (
              <FormField
                control={form.control}
                name="warehouseType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Warehouse Type</FormLabel>
                    <Select
                      value={field.value ?? ""}
                      onValueChange={field.onChange}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select warehouse type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {WAREHOUSE_TYPES.map((wt) => (
                          <SelectItem key={wt} value={wt}>
                            {wt.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Common location fields */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      City
                      <RequiredMark field="city" type={activeType} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="London"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Postal Code
                      <RequiredMark field="postalCode" type={activeType} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        placeholder="SW1A 1AA"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Country — plain Input; a full dropdown would need country data out of scope */}
            {/* TODO country dropdown */}
            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Country
                    <RequiredMark field="country" type={activeType} />
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      placeholder="United Kingdom"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Contact fields (PICKUP / DELIVERY / WAREHOUSE) */}
            {showContacts && (
              <div className="space-y-4 border-t pt-4">
                <p className="text-xs text-muted-foreground font-medium">
                  Contact Details
                </p>

                <FormField
                  control={form.control}
                  name="contactName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Contact Name
                        <RequiredMark field="contactName" type={activeType} />
                      </FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          placeholder="Jane Doe"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="contactPhone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Phone
                          <RequiredMark
                            field="contactPhone"
                            type={activeType}
                          />
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="tel"
                            placeholder="+44 20 7946 0958"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="contactEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Email
                          <RequiredMark
                            field="contactEmail"
                            type={activeType}
                          />
                        </FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="email"
                            placeholder="contact@company.com"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            )}

            {/* Optional contacts for hubs (AIRPORT / SEAPORT) */}
            {showOptionalContacts && (
              <div className="space-y-4 border-t pt-4">
                <p className="text-xs text-muted-foreground font-medium">
                  Contact Details (optional)
                </p>

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
                          placeholder="Operations team"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="contactPhone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="tel"
                            placeholder="+44 20 7946 0958"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="contactEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            type="email"
                            placeholder="ops@airport.com"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              {isEdit && (
                <Button type="button" variant="destructive" onClick={handleDelete} className="mr-auto">
                  Delete
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
