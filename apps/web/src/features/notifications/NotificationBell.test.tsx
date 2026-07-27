import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders";
import { NotificationBell } from "./NotificationBell";

const testUser = {
  id: "u1",
  name: "Agent",
  email: "a@x",
  role: "EXECUTIVE" as const,
};

const NOTIF_ID_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOTIF_ID_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const QUERY_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const notifications = [
  {
    id: NOTIF_ID_1,
    type: "ESCALATION",
    queryId: QUERY_ID,
    message: "Query YAL26-0001 awaiting action",
    readAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
  },
  {
    id: NOTIF_ID_2,
    type: "ESCALATION",
    queryId: null,
    message: "Another notification",
    readAt: null,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1 hr ago
  },
];

function makeFetch(fetchMock?: ReturnType<typeof vi.fn>) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/api/auth/me"))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user: testUser }),
        text: () => Promise.resolve(""),
        blob: () => Promise.resolve(new Blob()),
      } as Response);

    if (url.includes("/api/notifications/unread-count"))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ count: 2 }),
        text: () => Promise.resolve(JSON.stringify({ count: 2 })),
        blob: () => Promise.resolve(new Blob()),
      } as Response);

    if (url === "/api/notifications" && (!init?.method || init.method === "GET"))
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(notifications),
        text: () => Promise.resolve(JSON.stringify(notifications)),
        blob: () => Promise.resolve(new Blob()),
      } as Response);

    if (url.match(/\/api\/notifications\/.+\/read/) && init?.method === "PATCH") {
      if (fetchMock) fetchMock(url, init);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
        blob: () => Promise.resolve(new Blob()),
      } as Response);
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
      blob: () => Promise.resolve(new Blob()),
    } as Response);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NotificationBell", () => {
  it("shows the unread badge with count", async () => {
    vi.stubGlobal("fetch", makeFetch());

    renderWithProviders(<NotificationBell />, { user: testUser });

    // Badge shows the unread count
    expect(await screen.findByText("2")).toBeInTheDocument();
  });

  it("shows the unread badge and opens the feed with a notification item", async () => {
    vi.stubGlobal("fetch", makeFetch());

    renderWithProviders(<NotificationBell />, { user: testUser });

    // Badge shows 2
    expect(await screen.findByText("2")).toBeInTheDocument();

    // Open the feed by clicking the bell button
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));

    // Feed item appears
    expect(await screen.findByText(/awaiting action/i)).toBeInTheDocument();
  });

  it("marks an item read on click (PATCH fires)", async () => {
    const patchTracker = vi.fn();
    vi.stubGlobal("fetch", makeFetch(patchTracker));

    renderWithProviders(<NotificationBell />, { user: testUser });

    // Wait for badge
    await screen.findByText("2");

    // Open the feed
    await userEvent.click(screen.getByRole("button", { name: /notifications/i }));

    // Wait for the notification item to appear
    const item = await screen.findByText(/awaiting action/i);

    // Click the notification item
    await userEvent.click(item);

    // PATCH /api/notifications/<id>/read should have been called
    await waitFor(() => {
      expect(patchTracker).toHaveBeenCalledWith(
        `/api/notifications/${NOTIF_ID_1}/read`,
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("does not show badge when unread count is 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/me"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ user: testUser }),
            text: () => Promise.resolve(""),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        if (url.includes("/api/notifications/unread-count"))
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ count: 0 }),
            text: () => Promise.resolve(JSON.stringify({ count: 0 })),
            blob: () => Promise.resolve(new Blob()),
          } as Response);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
          blob: () => Promise.resolve(new Blob()),
        } as Response);
      }),
    );

    renderWithProviders(<NotificationBell />, { user: testUser });

    // Bell button should be present
    const bell = await screen.findByRole("button", { name: /notifications/i });
    expect(bell).toBeInTheDocument();

    // Badge (showing "0") should NOT be present
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
