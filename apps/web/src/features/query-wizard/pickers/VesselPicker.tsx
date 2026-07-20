import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown } from "lucide-react";
import type { VesselDto, Paginated } from "@svyft/shared";
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

interface VesselPickerProps {
  value?: { id: string; name: string } | null;
  onSelect: (v: VesselDto) => void;
}

export function VesselPicker({ value, onSelect }: VesselPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const { data } = useQuery({
    queryKey: ["vessels", q],
    queryFn: () =>
      fetchJson<Paginated<VesselDto>>(
        `/api/vessels?q=${encodeURIComponent(q)}`,
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
          aria-label={value?.name ? value.name : "Select vessel…"}
          className="w-full justify-between"
        >
          {value?.name ?? "Select vessel…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search vessel…"
            value={q}
            onValueChange={setQ}
          />
          <CommandList>
            {items.length === 0 ? (
              <CommandEmpty>
                {q.length === 0 ? "Type to search vessels…" : "No vessels found."}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {items.map((v) => (
                  <CommandItem
                    key={v.id}
                    value={v.id}
                    onSelect={() => {
                      onSelect(v);
                      setQ("");
                      setOpen(false);
                    }}
                  >
                    {v.name}
                    {v.imoNumber && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        IMO {v.imoNumber}
                      </span>
                    )}
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
