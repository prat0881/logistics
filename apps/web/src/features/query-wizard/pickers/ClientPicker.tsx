import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import type { ClientDto, Paginated } from "@svyft/shared";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api";

interface ClientPickerProps {
  value?: { id: string; companyName: string } | null;
  onSelect: (c: ClientDto) => void;
}

export function ClientPicker({ value, onSelect }: ClientPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const { data } = useQuery({
    queryKey: ["clients", q],
    queryFn: () =>
      fetchJson<Paginated<ClientDto>>(
        `/api/clients?q=${encodeURIComponent(q)}&status=ACTIVE`,
      ),
    enabled: q.length > 0,
  });

  const items = data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="button"
          aria-label={value?.companyName ? value.companyName : "Select client…"}
          className="w-full justify-between"
        >
          {value?.companyName ?? "Select client…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search client…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList>
            {items.length === 0 ? (
              <CommandEmpty>
                {q.length === 0 ? "Type to search clients…" : "No clients found."}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {items.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.id}
                    onSelect={() => {
                      onSelect(c);
                      setQ("");
                      setOpen(false);
                    }}
                  >
                    {c.companyName}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
