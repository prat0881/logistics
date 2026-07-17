import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}
