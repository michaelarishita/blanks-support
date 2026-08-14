// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, cleanup } from "@testing-library/react";
import { AUTHOR_FALLBACK } from "@/lib/display";
import type { Message } from "@/lib/types";

// Thread imports a "use server" module, which cannot be evaluated outside the
// Next request pipeline.
vi.mock("@/app/actions", () => ({ retryDelivery: vi.fn() }));

const Thread = (await import("@/components/Thread")).default;

beforeAll(() => {
  // jsdom has no layout, so the auto-scroll effect needs a stub.
  Element.prototype.scrollIntoView = vi.fn();
});

/** An outbound reply whose agent account has been deleted. */
const orphaned: Message = {
  id: "m1",
  ticket_id: "t1",
  direction: "outbound",
  type: "public",
  agent_id: null,
  body_text: "hello there",
  body_html: null,
  delivery_status: "sent",
  created_at: "2026-08-14T10:00:00.000Z",
  agent: null,
};

function authorFromMarkup(html: string): string | null {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder.querySelector('[data-testid="message-author"]')?.textContent ?? null;
}

describe("orphaned message author", () => {
  const props = { messages: [orphaned], customerName: "Ike", customerId: "c1" };

  it("renders the shared fallback on the server path", () => {
    const author = authorFromMarkup(renderToStaticMarkup(<Thread {...props} />));
    expect(author).toBe(AUTHOR_FALLBACK);
  });

  it("renders the shared fallback on the client path", () => {
    cleanup();
    const { container } = render(<Thread {...props} />);
    const author = container.querySelector('[data-testid="message-author"]')?.textContent;
    expect(author).toBe(AUTHOR_FALLBACK);
  });

  // The hydration failure: the two paths produced different strings because
  // the fallback literal existed in more than one place.
  it("produces the SAME author on both paths", () => {
    cleanup();
    const serverAuthor = authorFromMarkup(renderToStaticMarkup(<Thread {...props} />));
    const { container } = render(<Thread {...props} />);
    const clientAuthor = container.querySelector(
      '[data-testid="message-author"]'
    )?.textContent;

    expect(serverAuthor).toBe(clientAuthor);
    expect(serverAuthor).toBeTruthy();
  });

  it("renders no trace of the old literal on either path", () => {
    cleanup();
    const serverHtml = renderToStaticMarkup(<Thread {...props} />);
    const { container } = render(<Thread {...props} />);

    expect(serverHtml).not.toContain(">Agent<");
    expect(container.textContent).not.toContain("Agent");
  });

  it("still shows a present agent's real name", () => {
    cleanup();
    const named: Message = {
      ...orphaned,
      agent: { id: "a1", name: "michael", email: "m@x.com" } as Message["agent"],
    };
    const author = authorFromMarkup(
      renderToStaticMarkup(<Thread messages={[named]} customerName="Ike" />)
    );
    expect(author).toBe("michael");
  });

  it("shows the customer name on an inbound message", () => {
    cleanup();
    const inbound: Message = { ...orphaned, direction: "inbound" };
    const author = authorFromMarkup(
      renderToStaticMarkup(<Thread messages={[inbound]} customerName="Ike" />)
    );
    expect(author).toBe("Ike");
  });
});
