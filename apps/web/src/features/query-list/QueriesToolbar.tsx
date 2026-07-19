import { useState, useEffect, useCallback, useRef } from "react";
import { CalendarIcon, X } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { QUERY_STATUSES, PRIORITIES, FREIGHT_MODES } from "@svyft/shared";
import type { QueryListParams } from "@svyft/shared";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useAuth } from "@/features/auth/AuthProvider";
import { formatDate, toIsoOffset } from "@/lib/dates";

interface QueriesToolbarProps {
  onChange: (params: Partial<QueryListParams>) => void;
}

const EMPTY = "";

export function QueriesToolbar({ onChange }: QueriesToolbarProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(EMPTY);
  const [priority, setPriority] = useState(EMPTY);
  const [freightMode, setFreightMode] = useState(EMPTY);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [country, setCountry] = useState("");
  const [dateField, setDateField] = useState<"queryDate" | "updatedAt">("queryDate");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Keep a stable ref to onChange so the debounced search effect doesn't need
  // onChange in its dependency array (the ref always points to the latest value).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      onChangeRef.current({ q: search || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const emitFilters = useCallback(
    (overrides: Partial<{
      status: string;
      priority: string;
      freightMode: string;
      assignedToMe: boolean;
      country: string;
      dateField: "queryDate" | "updatedAt";
      dateRange: DateRange | undefined;
    }>) => {
      const s = overrides.status !== undefined ? overrides.status : status;
      const p = overrides.priority !== undefined ? overrides.priority : priority;
      const fm = overrides.freightMode !== undefined ? overrides.freightMode : freightMode;
      const atm = overrides.assignedToMe !== undefined ? overrides.assignedToMe : assignedToMe;
      const c = overrides.country !== undefined ? overrides.country : country;
      const df = overrides.dateField ?? dateField;
      const dr = overrides.dateRange !== undefined ? overrides.dateRange : dateRange;

      const params: Partial<QueryListParams> = {};
      if (s) params.status = s as QueryListParams["status"];
      if (p) params.priority = p as QueryListParams["priority"];
      if (fm) params.freightMode = fm;
      if (atm && user?.id) params.assignedUserId = user.id;
      if (c) params.country = c;
      if (dr?.from) {
        params.dateField = df;
        params.dateFrom = toIsoOffset(dr.from.toISOString().slice(0, 16));
        if (dr.to) params.dateTo = toIsoOffset(dr.to.toISOString().slice(0, 16));
      }
      onChange(params);
    },
    [status, priority, freightMode, assignedToMe, country, dateField, dateRange, user],
  );

  function handleStatus(val: string) {
    setStatus(val === "_all" ? EMPTY : val);
    emitFilters({ status: val === "_all" ? EMPTY : val });
  }
  function handlePriority(val: string) {
    setPriority(val === "_all" ? EMPTY : val);
    emitFilters({ priority: val === "_all" ? EMPTY : val });
  }
  function handleFreightMode(val: string) {
    setFreightMode(val === "_all" ? EMPTY : val);
    emitFilters({ freightMode: val === "_all" ? EMPTY : val });
  }
  function handleAssignedToggle() {
    const next = !assignedToMe;
    setAssignedToMe(next);
    emitFilters({ assignedToMe: next });
  }
  function handleCountry(e: React.ChangeEvent<HTMLInputElement>) {
    setCountry(e.target.value);
    emitFilters({ country: e.target.value });
  }
  function handleDateFieldToggle() {
    const next = dateField === "queryDate" ? "updatedAt" : "queryDate";
    setDateField(next);
    emitFilters({ dateField: next });
  }
  function handleDateRange(range: DateRange | undefined) {
    setDateRange(range);
    emitFilters({ dateRange: range });
    if (range?.from && range?.to) setCalendarOpen(false);
  }

  function clearFilters() {
    setSearch("");
    setStatus(EMPTY);
    setPriority(EMPTY);
    setFreightMode(EMPTY);
    setAssignedToMe(false);
    setCountry("");
    setDateField("queryDate");
    setDateRange(undefined);
    onChange({});
  }

  const hasFilters =
    search || status || priority || freightMode || assignedToMe || country || dateRange;

  const dateLabel = dateRange?.from
    ? dateRange.to
      ? `${formatDate(dateRange.from.toISOString())} – ${formatDate(dateRange.to.toISOString())}`
      : formatDate(dateRange.from.toISOString())
    : "Date range";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Search query code, customer…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-56"
        aria-label="Search"
      />

      <Select value={status || "_all"} onValueChange={handleStatus}>
        <SelectTrigger className="w-36" aria-label="Status filter">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All statuses</SelectItem>
          {QUERY_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s.replace(/_/g, " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={priority || "_all"} onValueChange={handlePriority}>
        <SelectTrigger className="w-32" aria-label="Priority filter">
          <SelectValue placeholder="Priority" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All priorities</SelectItem>
          {PRIORITIES.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={freightMode || "_all"} onValueChange={handleFreightMode}>
        <SelectTrigger className="w-28" aria-label="Freight mode filter">
          <SelectValue placeholder="Mode" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All modes</SelectItem>
          {FREIGHT_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant={assignedToMe ? "default" : "outline"}
        size="sm"
        onClick={handleAssignedToggle}
        aria-pressed={assignedToMe}
      >
        {assignedToMe ? "Assigned to me" : "All assignees"}
      </Button>

      <Input
        placeholder="Country"
        value={country}
        onChange={handleCountry}
        className="w-24"
        aria-label="Country filter"
      />

      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <CalendarIcon className="h-3.5 w-3.5" />
            <span>{dateLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="border-b p-2">
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={dateField === "queryDate" ? "default" : "outline"}
                onClick={() => {
                  if (dateField !== "queryDate") handleDateFieldToggle();
                }}
              >
                Query Date
              </Button>
              <Button
                size="sm"
                variant={dateField === "updatedAt" ? "default" : "outline"}
                onClick={() => {
                  if (dateField !== "updatedAt") handleDateFieldToggle();
                }}
              >
                Last Updated
              </Button>
            </div>
          </div>
          <Calendar
            mode="range"
            selected={dateRange}
            onSelect={handleDateRange}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>

      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1 text-muted-foreground">
          <X className="h-3.5 w-3.5" />
          Clear filters
        </Button>
      )}
    </div>
  );
}
