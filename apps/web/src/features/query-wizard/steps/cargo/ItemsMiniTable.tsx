import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { itemCreateSchema, itemUpdateSchema, UOMS, uomLabel } from "@svyft/shared";
import type { ItemCreateInput, ItemUpdateInput, ItemDto } from "@svyft/shared";
import { ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ReferenceTagIcons } from "@/components/ReferenceTagIcons";
import { NumericInput, ReferenceTags } from "./cargo-form-fields";
import { useItems } from "./useItems";

interface ItemsMiniTableProps {
  queryId: string;
  cargoId: string;
  packageId: string;
  items: ItemDto[];
  onItemsChange: (items: ItemDto[]) => void;
}

const BLANK_ITEM: ItemCreateInput = {
  product: "",
  qty: undefined,
  uom: undefined,
  hsCode: "",
  tags: [],
};

/**
 * ItemsMiniTable (Task 15) — item lines nested inside PackageEditor. Existing rows are
 * always-editable-on-demand (Edit toggles an inline form); a persistent add-form sits
 * below. V-4 (qty => uom) comes from itemCreateSchema/itemUpdateSchema's zodResolver, so
 * "qty entered without a UoM" surfaces as the uom FormField's error — no hand-rolled
 * validation here. Marking an item DG (or any other tag edit) bubbles the fresh ItemDto up
 * via onItemsChange so PackageEditor can recompute effectiveTags (own tags union item
 * tags) and reveal its MSDS control.
 */
export function ItemsMiniTable({
  queryId,
  cargoId,
  packageId,
  items,
  onItemsChange,
}: ItemsMiniTableProps) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground">Items</h4>
      {items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="font-mono tabular-nums">Qty</TableHead>
              <TableHead>UoM</TableHead>
              <TableHead>HSN</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                queryId={queryId}
                cargoId={cargoId}
                packageId={packageId}
                onChanged={(updated) =>
                  onItemsChange(items.map((i) => (i.id === updated.id ? updated : i)))
                }
                onRemoved={(id) => onItemsChange(items.filter((i) => i.id !== id))}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <AddItemForm
        queryId={queryId}
        cargoId={cargoId}
        packageId={packageId}
        onAdded={(created) => onItemsChange([...items, created])}
      />
    </div>
  );
}

/** One saved item: a read-only row with Edit/Remove, or (toggled) an inline update form. */
function ItemRow({
  item,
  queryId,
  cargoId,
  packageId,
  onChanged,
  onRemoved,
}: {
  item: ItemDto;
  queryId: string;
  cargoId: string;
  packageId: string;
  onChanged: (updated: ItemDto) => void;
  onRemoved: (id: string) => void;
}) {
  const itemActions = useItems(queryId, cargoId, packageId);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<ItemUpdateInput>({
    resolver: zodResolver(itemUpdateSchema),
    defaultValues: {
      product: item.product,
      qty: item.qty !== null ? Number(item.qty) : null,
      uom: item.uom,
      hsCode: item.hsCode,
      tags: item.tags,
    },
  });

  const handleRemove = async () => {
    try {
      setError(null);
      await itemActions.remove(item.id);
      onRemoved(item.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Remove failed");
    }
  };

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const updated = await itemActions.update(item.id, data);
      onChanged(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  if (!editing) {
    return (
      <TableRow>
        <TableCell>{item.product ?? "—"}</TableCell>
        <TableCell className="font-mono tabular-nums">{item.qty ?? "—"}</TableCell>
        <TableCell>{item.uom ? uomLabel(item.uom) : "—"}</TableCell>
        <TableCell>{item.hsCode ?? "—"}</TableCell>
        <TableCell>
          <ReferenceTagIcons tags={item.tags} />
        </TableCell>
        <TableCell>
          <div className="flex gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={handleRemove}>
              Remove
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell colSpan={6}>
        <Form {...form}>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
            <FormField
              control={form.control}
              name="product"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Product</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} className="h-8 w-32" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="qty"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Qty</FormLabel>
                  <FormControl>
                    <NumericInput
                      value={field.value ?? undefined}
                      onChange={field.onChange}
                      className="h-8 w-20 font-mono tabular-nums"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="uom"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">UoM</FormLabel>
                  <Select value={field.value ?? ""} onValueChange={field.onChange}>
                    <SelectTrigger aria-label="Unit of Measure" className="h-8 w-20">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {UOMS.map((u) => (
                        <SelectItem key={u} value={u}>
                          {uomLabel(u)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="hsCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">HSN</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} className="h-8 w-24" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="tags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Tags</FormLabel>
                  <FormControl>
                    <div data-testid={`item-${item.id}-tags`}>
                      <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive w-full">
                {error}
              </p>
            )}
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </form>
        </Form>
      </TableCell>
    </TableRow>
  );
}

/** The persistent "add a new item line" form. Uses itemCreateSchema so V-4 (qty => uom)
 * blocks the POST client-side and surfaces on the uom field. */
function AddItemForm({
  queryId,
  cargoId,
  packageId,
  onAdded,
}: {
  queryId: string;
  cargoId: string;
  packageId: string;
  onAdded: (item: ItemDto) => void;
}) {
  const itemActions = useItems(queryId, cargoId, packageId);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<ItemCreateInput>({
    resolver: zodResolver(itemCreateSchema),
    defaultValues: BLANK_ITEM,
  });

  const handleSubmit = form.handleSubmit(async (data) => {
    try {
      setError(null);
      const created = await itemActions.add(data);
      onAdded(created);
      form.reset(BLANK_ITEM);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Save failed");
    }
  });

  return (
    <Form {...form}>
      <form
        onSubmit={handleSubmit}
        className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-2"
      >
        <FormField
          control={form.control}
          name="product"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Product</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Deck paint"
                  className="h-8 w-32"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="qty"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Qty</FormLabel>
              <FormControl>
                <NumericInput
                  value={field.value}
                  onChange={field.onChange}
                  className="h-8 w-20 font-mono tabular-nums"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="uom"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">UoM</FormLabel>
              <Select value={field.value ?? ""} onValueChange={field.onChange}>
                <SelectTrigger aria-label="Unit of Measure" className="h-8 w-20">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {UOMS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {uomLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="hsCode"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">HSN</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  placeholder="3208.10"
                  className="h-8 w-24"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="tags"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Tags</FormLabel>
              <FormControl>
                <div data-testid="item-add-tags">
                  <ReferenceTags value={field.value ?? []} onChange={field.onChange} />
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive w-full">
            {error}
          </p>
        )}
        <Button type="submit" size="sm">
          Add Item
        </Button>
      </form>
    </Form>
  );
}
