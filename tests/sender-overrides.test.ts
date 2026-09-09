import { describe, expect, it } from "vitest";
import {
  domainOf,
  isFreemail,
  matchOverride,
  overrideTargetsFor,
  emptyOverrideList,
  type OverrideList,
} from "@/lib/senders/overrides";

describe("domainOf", () => {
  it("extracts the domain", () => {
    expect(domainOf("Bob@Vendor.COM")).toBe("vendor.com");
  });
  it("returns null for junk input", () => {
    expect(domainOf(null)).toBeNull();
    expect(domainOf("not-an-email")).toBeNull();
  });
});

describe("overrideTargetsFor — the freemail asymmetry", () => {
  it("writes both address and domain for a corporate sender", () => {
    expect(overrideTargetsFor("sales@acme-corp.com")).toEqual({
      address: "sales@acme-corp.com",
      domain: "acme-corp.com",
    });
  });

  it("writes ADDRESS ONLY for a freemail sender", () => {
    // Marking gmail.com as spam would junk every Gmail customer; not_spam would
    // make Gmail unjunkable. So a freemail correction never touches the domain.
    expect(isFreemail("gmail.com")).toBe(true);
    expect(overrideTargetsFor("spammer@gmail.com")).toEqual({
      address: "spammer@gmail.com",
      domain: null,
    });
  });
});

describe("matchOverride", () => {
  const list: OverrideList = emptyOverrideList();
  list.addresses.set("a@b.com", "spam");
  list.domains.set("vendor.com", "not_spam");

  it("matches an exact address", () => {
    expect(matchOverride("A@B.com", list)).toEqual({
      label: "spam",
      scope: "address",
      value: "a@b.com",
    });
  });

  it("matches a domain, and its subdomains", () => {
    expect(matchOverride("x@mail.vendor.com", list)?.label).toBe("not_spam");
  });

  it("prefers an address match over a domain match", () => {
    const both: OverrideList = emptyOverrideList();
    both.addresses.set("a@vendor.com", "not_spam");
    both.domains.set("vendor.com", "spam");
    expect(matchOverride("a@vendor.com", both)).toEqual({
      label: "not_spam",
      scope: "address",
      value: "a@vendor.com",
    });
  });

  it("returns null for an unknown sender", () => {
    expect(matchOverride("nobody@nowhere.com", list)).toBeNull();
    expect(matchOverride(null, list)).toBeNull();
  });
});
