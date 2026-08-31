import { useState } from "react";
import type { ContactUpsertInput } from "@svyft/shared";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ContactDialog } from "./ContactDialog";

export type ContactDraft = ContactUpsertInput;

function channelsLabel(c: ContactDraft): string {
  const channels: string[] = [];
  if (c.whatsappAvailable) channels.push("WhatsApp");
  if (c.wechatAvailable) channels.push("WeChat");
  if (c.botimAvailable) channels.push("Botim");
  return channels.length ? channels.join(", ") : "—";
}

export function ContactsSection({
  value,
  onChange,
  ownerNoun,
  lockedFirstRow = false,
}: {
  value: ContactDraft[];
  onChange: (next: ContactDraft[]) => void;
  ownerNoun: string;
  lockedFirstRow?: boolean;
}) {
  const [openIndex, setOpenIndex] = useState<number | "new" | null>(null);

  function upsert(draft: ContactDraft) {
    // Setting a contact PRIMARY demotes the incumbent here, in the draft. This is what makes
    // the API's second-primary 409 unreachable from the UI, and why the old ContactRow
    // PROMOTION_HINT ("demote the current primary first") no longer exists.
    const demoted =
      draft.pocLevel === "PRIMARY"
        ? value.map((c, i) =>
            i !== openIndex && c.pocLevel === "PRIMARY" ? { ...c, pocLevel: "SECONDARY" as const } : c,
          )
        : value;
    onChange(
      openIndex === "new" ? [...demoted, draft] : demoted.map((c, i) => (i === openIndex ? draft : c)),
    );
    setOpenIndex(null);
  }

  function remove() {
    if (typeof openIndex !== "number") return;
    onChange(value.filter((_, i) => i !== openIndex));
    setOpenIndex(null);
  }

  const editingInitial = typeof openIndex === "number" ? value[openIndex] : null;

  return (
    <section aria-label="Contacts" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold tracking-tight">Contacts</h2>
        <Button type="button" onClick={() => setOpenIndex("new")}>
          Add contact
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No contacts yet for this {ownerNoun}. Add at least one, including a primary.
        </p>
      ) : (
        <Table aria-label="Contacts">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead>POC</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.map((c, i) => (
              <TableRow key={c.id ?? `new-${i}`}>
                <TableCell>
                  {lockedFirstRow && i === 0 ? (
                    c.name
                  ) : (
                    <button
                      type="button"
                      className="font-medium underline-offset-4 hover:underline"
                      onClick={() => setOpenIndex(i)}
                    >
                      {c.name}
                    </button>
                  )}
                </TableCell>
                <TableCell>{c.designation || "—"}</TableCell>
                <TableCell>{c.email}</TableCell>
                <TableCell>{c.contactNo}</TableCell>
                <TableCell>{channelsLabel(c)}</TableCell>
                <TableCell>{c.pocLevel && c.pocLevel !== "NONE" ? c.pocLevel : "—"}</TableCell>
                <TableCell>{c.status ?? "ACTIVE"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ContactDialog
        key={openIndex ?? "closed"}
        open={openIndex !== null}
        initial={editingInitial ?? null}
        onSave={upsert}
        onRemove={remove}
        onClose={() => setOpenIndex(null)}
      />
    </section>
  );
}
