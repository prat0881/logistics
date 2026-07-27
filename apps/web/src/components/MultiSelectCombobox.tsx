import { useState } from "react";
import { ChevronsUpDown, X } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";

interface Option {
  code: string;
  name: string;
}
interface Props {
  value: string[];
  options: readonly Option[];
  onChange: (v: string[]) => void;
  ariaLabel: string;
  placeholder?: string;
}

export function MultiSelectCombobox({ value, options, onChange, ariaLabel, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const nameOf = (code: string) => options.find((o) => o.code === code)?.name ?? code;
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" aria-label={ariaLabel} className="w-full justify-between font-normal">
            {value.length > 0 ? `${value.length} selected` : (placeholder ?? `Select…`)}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput placeholder={`Search ${ariaLabel.toLowerCase()}…`} />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.code} value={o.name} onSelect={() => toggle(o.code)}>
                    <input type="checkbox" checked={value.includes(o.code)} readOnly className="mr-2" />
                    {o.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((code) => (
            <Badge key={code} variant="secondary" className="gap-1">
              {nameOf(code)}
              <button
                type="button"
                aria-label={`Remove ${nameOf(code)}`}
                onClick={() => toggle(code)}
                className="ml-1 focus:outline-none"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
