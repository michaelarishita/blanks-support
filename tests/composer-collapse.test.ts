import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const composer = read("../components/ReplyBox.tsx");

/**
 * The composer idles as one line on a phone.
 *
 * Measured in WebKit at iPhone 13 size: the full composer was 257px of a 664px
 * viewport, and with the header and context bar the thread got 251px. Collapsed
 * it is 61px and the thread gets 500px — the conversation being what somebody
 * opened the ticket to read.
 *
 * Structural, because the failures here are about SHAPE — an unmounted editor,
 * a lost draft, a collapse that fires on the wrong blur — and each one is
 * invisible to a test that only exercises the happy path.
 */
describe("what holds the composer open", () => {
  it("derives expanded rather than storing it alone", () => {
    // A plain boolean would let the composer fold over text somebody wrote.
    // Draft and error are part of the expression, so neither can be collapsed
    // away by a stray blur.
    expect(composer).toMatch(
      /const expanded =\s*openedByTap \|\| !isEmptyHtml\(body\) \|\| Boolean\(error\)/
    );
  });

  it("only collapses when the composer is empty", () => {
    expect(composer).toMatch(/if \(isEmptyHtml\(body\)\) setOpenedByTap\(false\)/);
  });

  it("ignores a blur that stayed inside the composer", () => {
    // Tapping Macros, the mode tabs or Send all blur the editor. Folding the
    // composer at that moment would make it unusable — you would lose the
    // control you just reached for.
    expect(composer).toMatch(
      /currentTarget\.contains\(event\.relatedTarget as Node \| null\)\)\s*return/
    );
  });
});

describe("the draft survives collapsing", () => {
  it("hides the editor rather than unmounting it", () => {
    // Unmounting would tear down the editor's DOM and drop the text mid
    // sentence; the draft-restore effect only re-runs when the ticket or mode
    // changes, so it would not come back.
    expect(composer).toContain('!expanded && "hidden sm:block"');
    // The editor must NOT be inside a conditional render.
    expect(composer).not.toMatch(/\{expanded && [\s\S]{0,200}<RichTextEditor/);
  });

  it("keeps the per-ticket, per-mode draft key untouched", () => {
    // The one way this could do harm is a note draft reappearing as a public
    // reply, which the key prevents. Collapsing must not have changed it.
    expect(composer).toContain("const draftKey = `blanks-draft:${ticketId}:${mode}`");
  });
});

describe("focus", () => {
  it("focuses after the commit that reveals the editor", () => {
    // Focusing a display:none element silently does nothing, so this cannot
    // happen in the click handler — the editor is still hidden there.
    expect(composer).toMatch(
      /useEffect\(\(\) => \{\s*if \(!expanded \|\| !wantsFocus\.current\) return;/
    );
  });

  it("expands when a keyboard shortcut asks for the composer", () => {
    // r and n focus the composer. On a narrow viewport that means it has to
    // open first, or the shortcut focuses something nobody can see.
    const focusComposer = composer.slice(
      composer.indexOf("const focusComposer"),
      composer.indexOf("useHotkey(\"r\"")
    );
    expect(focusComposer).toContain("setOpenedByTap(true)");
  });

  it("collapses again once the reply has gone", () => {
    const submit = composer.slice(composer.indexOf("function submit()"));
    expect(submit).toMatch(/editorRef\.current\?\.clear\(\);[\s\S]{0,200}setOpenedByTap\(false\)/);
  });
});

describe("desktop is untouched", () => {
  it("never renders the collapsed bar above sm", () => {
    expect(composer).toMatch(/sm:hidden[\s\S]{0,400}Write a reply/);
  });

  it("always shows the full composer above sm", () => {
    // `hidden sm:block` — the collapse is a mobile-only concession, and on a
    // desktop the 257px costs nobody anything.
    expect(composer).toContain('"hidden sm:block"');
  });

  it("keeps the tighter collapsed padding off desktop", () => {
    expect(composer).toContain('"pb-safe-2 pt-2 sm:pb-safe-3 sm:pt-3"');
  });
});

describe("what the collapse must not have broken", () => {
  it("keeps the keyboard inset on the sticky wrapper", () => {
    // iOS does not shrink the layout viewport for the keyboard. Without this
    // the expanded composer sits behind it and you type into something you
    // cannot see — the single biggest cause of "I can't use it on my phone".
    expect(composer).toContain("useKeyboardInset");
    expect(composer).toMatch(
      /style=\{keyboardInset \? \{ paddingBottom: keyboardInset \} : undefined\}/
    );
  });

  it("still says which mode the collapsed bar would post in", () => {
    // Note mode is the one thing that must never be ambiguous: it decides
    // whether the customer sees what you type.
    expect(composer).toMatch(/isNote \? "Internal note[\s\S]{0,60}: "Write a reply/);
  });
});
