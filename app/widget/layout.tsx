import type { Metadata } from "next";

// page.tsx is a client component and so cannot export metadata itself. This
// layout exists for that alone.
//
// The title and description are customer-facing: this page is linked directly
// from the storefront's contact page, so it is a destination people land on
// and see in a browser tab, not only an iframe body.
export const metadata: Metadata = {
  title: "Contact us · Blank's Sports Nutrition",
  description:
    "Questions about an order, a product, wholesale or sponsorship? Send the Blank's Sports Nutrition team a message and we'll reply by email, usually within one business day.",
};

export default function WidgetLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
