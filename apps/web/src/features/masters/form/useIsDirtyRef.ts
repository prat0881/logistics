import { useRef, type MutableRefObject } from "react";

/**
 * A ref mirroring react-hook-form's `formState.isDirty`, for the load effects that hydrate a
 * master form from the server.
 *
 * **The hazard.** `queryClient` is constructed bare (`lib/api.ts`), so `refetchOnWindowFocus` is
 * on with `staleTime: 0`: tabbing away to copy an address and back refetches the record while the
 * form is open. Every master form hydrates through
 * `useEffect(() => { ... reset({ ... }) }, [query.data, reset])`, and `reset()` replaces the
 * ENTIRE draft — typed fields, contacts, vehicles and warehouse selections alike — with no
 * warning and no undo.
 *
 * **It bites only when the refetched record actually differs**, and that bound is worth stating
 * precisely, because the looser version of this claim produced a test that could not fail.
 * react-query applies structural sharing (`replaceEqualDeep`), so a refetch returning a deeply
 * equal body keeps the PREVIOUS object reference: `query.data`'s identity does not change and the
 * effect does not re-run. The reachable case is a concurrent edit — someone else changes the
 * record while this user has it open — after which their in-progress work is silently replaced by
 * the other person's version. `ClientFormPage.test.tsx` pins exactly that sequence.
 *
 * Guarding the hydration on `isDirty` closes it: hydrate freely until the user has touched
 * something, never after.
 *
 * **Why a ref rather than a dependency.** Putting `isDirty` in the effect's dependency array
 * re-runs the hydration every time it flips — including the flip back to `false` that `reset()`
 * and a successful submit both cause — which reintroduces the clobber it was meant to prevent.
 * A ref read inside the effect body always sees the latest committed value and stays out of the
 * dependency array entirely. Assigning during render (rather than in an effect) is what makes it
 * current by the time any effect in the same commit reads it.
 *
 * **Why `isDirty` rather than "hydrate only once".** `ClientFormPage` and
 * `FreightForwarderFormPage` hydrate from three independent queries that land at different times,
 * so the effect legitimately re-runs as each arrives; a once-only ref would leave contacts or
 * warehouses unhydrated. `isDirty` keeps that behaviour intact and only blocks the case that
 * destroys work.
 *
 * The narrower alternative of setting `refetchOnWindowFocus: false` on the QueryClient was
 * rejected: it changes fetching for the query wizard, RFQ workspace and Compare too, none of
 * which have this problem.
 */
export function useIsDirtyRef(isDirty: boolean): MutableRefObject<boolean> {
  const ref = useRef(isDirty);
  ref.current = isDirty;
  return ref;
}
