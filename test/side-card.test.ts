// The suggestion card floating in the right margin (`src/app/editor/sideCard.ts`). The card's content and the gestures
// that open it are `suggestion-ui.test.ts`; what is tested here is where it goes — the rule that keeps it beside its
// diff and in view as the page scrolls, which is arithmetic and can be checked without laying anything out.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => { document.body.innerHTML = ""; });

const { diffExtent, sideCard, stickyTop } = await import("../src/app/editor/sideCard");

/** The viewport between the bars, as `sideCard` works in. */
const VIEW = { top: 100, bottom: 700 };

describe("where the card sits beside its diff", () => {
  const CARD = 120;

  test("a diff in full view: the card is level with its top", () => {
    expect(stickyTop({ top: 200, bottom: 500 }, CARD, VIEW)).toBe(200);
  });

  test("as the diff scrolls up past the top of the view, the card is held there, whole", () => {
    // The diff's top has gone above the view; the card stays at the top of what is visible rather than following it up.
    expect(stickyTop({ top: 20, bottom: 500 }, CARD, VIEW)).toBe(VIEW.top);
    expect(stickyTop({ top: -400, bottom: 500 }, CARD, VIEW)).toBe(VIEW.top);
  });

  test("it stays whole at the top of the view while any of the diff shows, even a sliver", () => {
    // Being whole wins over sitting within the diff: with 60px of a tall diff left, the card is still at the top of
    // the view and overhangs it, rather than being pushed up out of sight to stay inside it.
    expect(stickyTop({ top: -400, bottom: VIEW.top + 60 }, CARD, VIEW)).toBe(VIEW.top);
    expect(stickyTop({ top: -400, bottom: VIEW.top + 1 }, CARD, VIEW)).toBe(VIEW.top);
  });

  test("a diff shorter than the card keeps it at the diff's top, rather than pulling it above", () => {
    // `diff.bottom - h` is above the diff here, and the card is not dragged up past the thing it belongs to.
    const y = stickyTop({ top: 300, bottom: 320 }, CARD, VIEW);
    expect(y).toBe(300);
  });

  test("the card is kept whole inside the view, never over the bottom bar", () => {
    const y = stickyTop({ top: VIEW.bottom - 20, bottom: VIEW.bottom + 400 }, CARD, VIEW)!;
    expect(y).toBe(VIEW.bottom - CARD);
    expect(y + CARD).toBeLessThanOrEqual(VIEW.bottom);
  });

  test("a diff with none of it in view has nowhere to put the card", () => {
    expect(stickyTop({ top: -500, bottom: VIEW.top }, CARD, VIEW)).toBeNull(); // ends exactly at the top edge
    expect(stickyTop({ top: -900, bottom: -100 }, CARD, VIEW)).toBeNull(); // scrolled off above
    expect(stickyTop({ top: VIEW.bottom, bottom: 2000 }, CARD, VIEW)).toBeNull(); // starts exactly at the bottom edge
    expect(stickyTop({ top: 1200, bottom: 2000 }, CARD, VIEW)).toBeNull(); // below the fold
  });

  test("the whole rule, over every shape of diff: the diff's top, kept inside the view", () => {
    // What the three lines of `stickyTop` come to. Checked here rather than left implied, because two of those lines
    // cannot change the answer — the clamp into the view already does their work — so a test of each in turn would
    // pass whether they were there or not. Pin the rule instead, and a simpler version of it stays honest.
    const rule = (diff: { top: number; bottom: number }, h: number, v: { top: number; bottom: number }) =>
      diff.bottom <= v.top || diff.top >= v.bottom ? null : Math.max(v.top, Math.min(diff.top, v.bottom - h));
    for (let top = -600; top <= 900; top += 23) {
      for (let len = 1; len <= 1200; len += 37) {
        for (const h of [0, 1, 40, CARD, 400, 900]) {
          for (const v of [VIEW, { top: 0, bottom: 400 }, { top: 50, bottom: 1000 }]) {
            const diff = { top, bottom: top + len };
            expect(stickyTop(diff, h, v)).toBe(rule(diff, h, v));
          }
        }
      }
    }
  });

  test("a diff taller than the view keeps the card at the top for as long as any of it shows", () => {
    const tall = { top: -2000, bottom: 2000 };
    expect(stickyTop(tall, CARD, VIEW)).toBe(VIEW.top);
    // And a card as tall as the view still fits in it.
    const y = stickyTop(tall, VIEW.bottom - VIEW.top, VIEW)!;
    expect(y).toBe(VIEW.top);
  });
});

/** An element of suggestion `id` that reports `rect` as its place on screen. */
function drawn(id: string, rect: { top: number; bottom: number; width?: number; height?: number }) {
  const el = document.createElement("span");
  el.dataset.sug = id;
  const box = { top: rect.top, bottom: rect.bottom, width: rect.width ?? 50, height: rect.height ?? rect.bottom - rect.top, left: 0, right: 50, x: 0, y: rect.top, toJSON: () => ({}) };
  el.getBoundingClientRect = () => box as DOMRect;
  document.body.append(el);
  return el;
}

describe("how much of the page a suggestion draws over", () => {
  test("everything it draws, taken together, top to bottom", () => {
    drawn("a", { top: 300, bottom: 340 });
    drawn("a", { top: 180, bottom: 220 });
    drawn("a", { top: 260, bottom: 280 });
    expect(diffExtent(document.body, "a")).toEqual({ top: 180, bottom: 340 });
  });

  test("only what belongs to that suggestion", () => {
    drawn("a", { top: 200, bottom: 240 });
    drawn("b", { top: 900, bottom: 940 });
    expect(diffExtent(document.body, "a")).toEqual({ top: 200, bottom: 240 });
  });

  test("something drawn with no size at all is passed over, so it can't stretch the extent", () => {
    drawn("a", { top: 200, bottom: 240 });
    drawn("a", { top: 0, bottom: 0, width: 0, height: 0 });
    expect(diffExtent(document.body, "a")).toEqual({ top: 200, bottom: 240 });
  });

  test("a suggestion that draws nothing has no extent", () => {
    expect(diffExtent(document.body, "gone")).toBeNull();
    // Nor does one whose every part has no size.
    drawn("empty", { top: 0, bottom: 0, width: 0, height: 0 });
    expect(diffExtent(document.body, "empty")).toBeNull();
  });
});

describe("the one card an editor has", () => {
  const root = () => { const r = document.createElement("div"); r.className = "sheet"; document.body.append(r); return r; };
  const content = (text: string) => { const el = document.createElement("p"); el.textContent = text; return el; };

  test("showing it puts it on the page for that suggestion; hiding takes it off", () => {
    const card = sideCard(root());
    expect(card.id).toBeNull();
    card.show("a", content("what it did"));
    expect(card.id).toBe("a");
    const box = document.querySelector<HTMLElement>(".sug-side")!;
    expect(box).not.toBeNull();
    expect(box.dataset.for).toBe("a");
    expect(box.textContent).toBe("what it did");
    // A dialog, so what reads the page aloud announces it as one.
    expect(box.getAttribute("role")).toBe("dialog");
    card.hide();
    expect(card.id).toBeNull();
    expect(document.querySelector(".sug-side")).toBeNull();
    card.destroy();
  });

  test("showing another suggestion's card replaces what was there, rather than stacking", () => {
    const card = sideCard(root());
    card.show("a", content("first"));
    card.show("b", content("second"));
    expect(document.querySelectorAll(".sug-side")).toHaveLength(1);
    const box = document.querySelector<HTMLElement>(".sug-side")!;
    expect(box.dataset.for).toBe("b");
    expect(box.textContent).toBe("second");
    card.destroy();
  });

  test("it knows what is inside it, so a click there isn't read as a click away", () => {
    const card = sideCard(root());
    const inside = content("what it did");
    card.show("a", inside);
    expect(card.contains(inside)).toBe(true);
    expect(card.contains(inside.firstChild)).toBe(true);
    const elsewhere = content("the page");
    document.body.append(elsewhere);
    expect(card.contains(elsewhere)).toBe(false);
    expect(card.contains(null)).toBe(false);
    card.destroy();
  });

  test("an agent's note the card would cut across steps aside until the card has gone, and only that one", () => {
    const at = (el: Element, top: number, height: number) => {
      el.getBoundingClientRect = () => ({ left: 16, right: 296, width: 280, top, bottom: top + height, height, x: 16, y: top, toJSON() {} });
    };
    const page = root();
    const diff = document.createElement("span");
    diff.dataset.sug = "a";
    at(diff, 100, 40);
    page.append(diff);
    const note = (top: number) => { const n = document.createElement("div"); n.className = "agent-note"; at(n, top, 28); document.body.append(n); return n; };
    const under = note(150), below = note(400);
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains("sug-side") ? ({ left: 16, right: 296, width: 280, top: 100, bottom: 300, height: 200, x: 16, y: 100, toJSON() {} }) : real.call(this);
    };
    try {
      const card = sideCard(page);
      card.show("a", content("what it did"));
      expect(under.hasAttribute("data-covered")).toBe(true);
      expect(below.hasAttribute("data-covered")).toBe(false);
      card.hide();
      expect(under.hasAttribute("data-covered")).toBe(false);
      card.destroy();
    } finally { HTMLElement.prototype.getBoundingClientRect = real; }
  });

  test("it takes the accent of the card's kind, so one popover serves every kind of comment", () => {
    const card = sideCard(root());
    const answer = content("an answer");
    answer.dataset.kind = "answer";
    card.show("a", answer);
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.kind).toBe("answer");
    card.show("b", content("no kind"));
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.kind).toBe("");
    card.destroy();
  });

  describe("the line that joins it to its diff", () => {
    const box = (left: number, top: number, w: number, h: number) =>
      ({ left, right: left + w, width: w, top, bottom: top + h, height: h, x: left, y: top, toJSON() {} }) as DOMRect;
    /** A page whose sheet ends at x=800 (so the card goes at 816), with `a`'s diff drawn as the given pieces. */
    const page = (...pieces: DOMRect[]) => {
      const r = root();
      r.getBoundingClientRect = () => box(100, 0, 700, 2000);
      const diff = document.createElement("span");
      diff.dataset.sug = "a";
      diff.getBoundingClientRect = () => box(100, Math.min(...pieces.map((p) => p.top)), 600, Math.max(...pieces.map((p) => p.bottom)) - Math.min(...pieces.map((p) => p.top)));
      diff.getClientRects = () => pieces as unknown as DOMRectList;
      r.append(diff);
      return r;
    };
    const content = () => { const el = document.createElement("p"); el.textContent = "x"; return el; };

    test("a line runs from the card to the end of the diff, and goes with the card", () => {
      const card = sideCard(page(box(100, 200, 600, 40)));
      card.show("a", content());
      const link = document.querySelector(".sug-link")!;
      expect(link).not.toBeNull();
      expect(link.getAttribute("aria-hidden")).toBe("true");
      expect(link.querySelector("path")!.getAttribute("d")).toContain("M816 ");
      expect(link.querySelector("circle")!.getAttribute("cx")).toBe("702"); // the diff's right edge, and a little
      card.hide();
      expect(document.querySelector(".sug-link")).toBeNull();
      card.destroy();
    });

    test("of a diff in several pieces it joins the one level with the card, and ends on it", () => {
      // The card sits level with the diff's top (200), so its line starts at 218: inside the first piece, far from the
      // chip-sized second one, and the dot is put at that height, not at the piece's middle.
      const card = sideCard(page(box(100, 200, 600, 400), box(100, 700, 650, 20)));
      card.show("a", content());
      expect(document.querySelector(".sug-link path")!.getAttribute("d")!.startsWith("M816 218 ")).toBe(true);
      expect(document.querySelector(".sug-link circle")!.getAttribute("cx")).toBe("702");
      expect(document.querySelector(".sug-link circle")!.getAttribute("cy")).toBe("218");
      card.destroy();
    });

    test("a card that is over the page, with nothing to its left to join, draws no line", () => {
      const r = root();
      r.getBoundingClientRect = () => box(0, 0, 1000, 2000); // card goes at 1016 (clamped to the window), the diff ends at 1010
      const diff = document.createElement("span");
      diff.dataset.sug = "a";
      diff.getBoundingClientRect = () => box(10, 200, 1000, 40);
      diff.getClientRects = () => [box(10, 200, 1000, 40)] as unknown as DOMRectList;
      r.append(diff);
      const card = sideCard(r);
      card.show("a", content());
      expect(document.querySelector(".sug-link")).toBeNull();
      card.destroy();
    });

    test("destroying the card takes its line off the page too", () => {
      const card = sideCard(page(box(100, 200, 600, 40)));
      card.show("a", content());
      expect(document.querySelector(".sug-link")).not.toBeNull();
      card.destroy();
      expect(document.querySelector(".sug-link")).toBeNull();
    });
  });

  test("a card whose diff has gone from the page is hidden rather than left somewhere wrong", () => {
    const card = sideCard(root());
    card.show("a", content("what it did")); // nothing is drawn for "a", so there is nowhere to put it
    expect(document.querySelector<HTMLElement>(".sug-side")!.style.visibility).toBe("hidden");
    card.destroy();
  });

  test("destroying it stops it listening, so a scroll afterwards moves nothing", () => {
    const card = sideCard(root());
    card.show("a", content("what it did"));
    card.destroy();
    expect(document.querySelector(".sug-side")).toBeNull();
    expect(card.id).toBeNull();
    // The listeners went with it: a scroll now must not put the card back on the page.
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelector(".sug-side")).toBeNull();
    card.destroy(); // twice is fine
  });
});
