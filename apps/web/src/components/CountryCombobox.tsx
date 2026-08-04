// apps/web/src/components/CountryCombobox.tsx
import { useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { COUNTRIES, getCountryName } from "@svyft/shared";
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

const KNOWN_CODES: string[] = COUNTRIES.map((c) => c.code);

interface CountryOption {
  code: string;
  name: string;
}

interface Props {
  value?: string;
  onChange: (code: string) => void;
  ariaLabel?: string;
}

export function CountryCombobox({ value, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  // Legacy point data may hold a free-text country (e.g. "United Kingdom") that
  // isn't a known ISO code. Prepend it so the trigger still shows something
  // sensible and the row is present for the user to move to a proper code.
  const options: readonly CountryOption[] = useMemo(
    () =>
      value && !KNOWN_CODES.includes(value)
        ? [{ code: value, name: value }, ...COUNTRIES]
        : COUNTRIES,
    [value],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="button"
          aria-label={ariaLabel ?? "Select country"}
          className="w-full justify-between font-normal"
        >
          {value ? getCountryName(value) : "Select country…"}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country…" />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {options.map((c) => (
                <CommandItem
                  key={c.code}
                  value={c.code}
                  keywords={[c.name]}
                  onSelect={() => {
                    onChange(c.code);
                    setOpen(false);
                  }}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
