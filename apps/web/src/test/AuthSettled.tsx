import { useAuth } from "@/features/auth/AuthProvider";

/**
 * A positive control for tests that assert role-gated UI is ABSENT.
 *
 * `useCanWrite()` reads `user?.role`, and `AuthProvider` renders its children immediately with
 * `user = null` while `/api/auth/me` is still in flight. So `canWrite` is false *while loading*
 * and false *for an Executive* — two states a "the New button is not there" assertion cannot tell
 * apart. Awaiting the page's own data first does not fix it: the list query and the auth probe are
 * independent requests that can resolve in either order, so the absence assertion routinely runs
 * against the loading state. Such a test passes unchanged if the role check is deleted outright.
 *
 * Rendering this alongside the component under test gives the assertion something that can only
 * appear once auth has settled to a specific role:
 *
 *     renderList("EXECUTIVE", <AuthSettled />);
 *     expect(await screen.findByText("auth role: EXECUTIVE")).toBeInTheDocument();
 *     expect(screen.queryByRole("link", { name: /new client/i })).not.toBeInTheDocument();
 *
 * It reads the same context `useCanWrite()` reads, so settlement here is settlement there.
 *
 * **Not the right tool for a redirect.** Where the gate is a route guard rather than a hidden
 * control (`App.test.tsx`'s AdminOnly cases), assert on the redirect *destination* instead — the
 * arrival of the target screen is its own positive control, and it additionally proves the
 * redirect happened rather than the route merely failing to render.
 *
 * Originally defined inside `FxRatesPage.test.tsx`, the only test that had it; lifted here when
 * the same race was found in the four masters list pages.
 */
export function AuthSettled() {
  const { loading, user } = useAuth();
  return <p>{loading ? "auth loading" : `auth role: ${user?.role ?? "none"}`}</p>;
}
