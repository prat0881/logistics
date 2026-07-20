import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryDetail } from "@svyft/shared";
import { useQueryDetail } from "./useQueryDetail";

export const STEPS = [
  { key: "client", label: "Client & Query" },
  { key: "shipment", label: "Shipment" },
  { key: "cargo", label: "Cargo" },
  { key: "legs", label: "Legs / Route" },
  { key: "notes", label: "Notes & Checklist" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

interface WizardContextValue {
  detail?: QueryDetail;
  queryId?: string;
  isNew: boolean;
  step: number;
  setStep: (n: number) => void;
  goNext: () => void;
  goBack: () => void;
  refresh: () => Promise<void>;
}

const WizardContext = createContext<WizardContextValue | undefined>(undefined);

interface WizardProviderProps {
  id?: string;
  children: ReactNode;
}

export function WizardProvider({ id, children }: WizardProviderProps) {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryId = id;
  const isNew = !queryId;

  // Parse step from ?step= param (0-based index), default to 0
  const stepParam = parseInt(searchParams.get("step") ?? "0", 10);
  const clampedStep = Number.isNaN(stepParam) ? 0 : Math.max(0, Math.min(stepParam, STEPS.length - 1));
  const [localStep, setLocalStep] = useState<number>(clampedStep);

  const { data: detail } = useQueryDetail(queryId);

  const step = queryId !== undefined ? clampedStep : localStep;

  const setStep = useCallback(
    (n: number) => {
      const clamped = Math.max(0, Math.min(n, STEPS.length - 1));
      // Jump-to only allowed when detail exists (i.e., query has been created)
      if (!detail) return;
      if (queryId) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("step", String(clamped));
          return next;
        });
      } else {
        setLocalStep(clamped);
      }
    },
    [detail, queryId, setSearchParams],
  );

  const goNext = useCallback(() => {
    const next = Math.min(step + 1, STEPS.length - 1);
    if (queryId) {
      setSearchParams((prev) => {
        const ns = new URLSearchParams(prev);
        ns.set("step", String(next));
        return ns;
      });
    } else {
      setLocalStep(next);
    }
  }, [step, queryId, setSearchParams]);

  const goBack = useCallback(() => {
    const prev = Math.max(step - 1, 0);
    if (queryId) {
      setSearchParams((sp) => {
        const ns = new URLSearchParams(sp);
        ns.set("step", String(prev));
        return ns;
      });
    } else {
      setLocalStep(prev);
    }
  }, [step, queryId, setSearchParams]);

  const refresh = useCallback(async () => {
    if (queryId) {
      await qc.invalidateQueries({ queryKey: ["query", queryId] });
    }
  }, [qc, queryId]);

  return (
    <WizardContext.Provider
      value={{ detail, queryId, isNew, step, setStep, goNext, goBack, refresh }}
    >
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error("useWizard must be used within WizardProvider");
  return ctx;
}
