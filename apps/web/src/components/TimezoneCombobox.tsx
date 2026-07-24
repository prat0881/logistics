// apps/web/src/components/TimezoneCombobox.tsx
import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { zoneLabel } from "@svyft/shared";
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

const IANA_ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

// Minimal alias keywords so common non-canonical names still find the row.
const ALIASES: Record<string, string[]> = {
  "Asia/Calcutta": ["kolkata"],
  "Asia/Kolkata": ["calcutta"],
};

const city = (z: string) => z.split("/").pop()!.replace(/_/g, " ");
const region = (z: string) => z.split("/")[0];

interface Props {
  value?: string;
  onChange: (zone: string) => void;
  ariaLabel?: string;
}

export function TimezoneCombobox({ value, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(
    () => (value && !IANA_ZONES.includes(value) ? [value, ...IANA_ZONES] : IANA_ZONES),
    [value],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="button"
          aria-label={ariaLabel ?? "Select timezone"}
          className="w-full justify-between font-normal"
        >
          {value ? `${value} (${zoneLabel(value)})` : "Select timezone…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup>
              {zones.map((z) => (
                <CommandItem
                  key={z}
                  value={z}
                  keywords={[city(z), region(z), zoneLabel(z), ...(ALIASES[z] ?? [])]}
                  onSelect={() => {
                    onChange(z);
                    setOpen(false);
                  }}
                >
                  {z} ({zoneLabel(z)})
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
