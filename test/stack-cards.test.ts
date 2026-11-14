// How the cards of a margin column (the questions, the agent's notes) keep off each other: arithmetic, so no layout.
import { describe, expect, test } from "bun:test";
import { stackCards, type CardBox } from "../src/app/pages/stackCards";

const GAP = 8;
const card = (top: number, height = 40): CardBox => ({ top, height });

/** No card touches the next, however the input was ordered. */
function clear(cards: CardBox[], tops: number[]) {
  const placed = tops.map((top, i) => ({ top, height: cards[i]!.height })).sort((a, b) => a.top - b.top);
  for (let i = 1; i < placed.length; i++) expect(placed[i]!.top).toBeGreaterThanOrEqual(placed[i - 1]!.top + placed[i - 1]!.height + GAP - 1);
}

describe("stacking the cards of a margin column", () => {
  test("cards with room stay level with their passages", () => {
    expect(stackCards([card(100), card(300)], GAP)).toEqual([100, 300]);
  });

  test("two on one line straddle it, rather than the second falling below", () => {
    expect(stackCards([card(200), card(200)], GAP)).toEqual([176, 224]);
  });

  test("a cluster spreads about its passages: the furthest card moves half what pushing down would move it", () => {
    const cards = [card(200), card(210), card(220), card(230), card(240)];
    const tops = stackCards(cards, GAP);
    clear(cards, tops);
    expect(Math.abs(tops[4]! - 240)).toBeLessThan(((200 + 4 * 48) - 240) * 0.75);
  });

  test("a group that grows into the one above joins it", () => {
    const cards = [card(100), card(150), card(150), card(150)];
    clear(cards, stackCards(cards, GAP));
  });

  test("never above the top of the column", () => {
    const tops = stackCards([card(0), card(5), card(10)], GAP);
    expect(tops).toEqual([0, 48, 96]);
  });

  test("the answer is in the order given, whatever order the passages are in", () => {
    expect(stackCards([card(300), card(100)], GAP)).toEqual([300, 100]);
  });

  test("cards of different heights, in any order, never touch", () => {
    const cards = [card(90, 120), card(40, 28), card(95, 60), card(400, 200), card(410, 28), card(0, 64)];
    clear(cards, stackCards(cards, GAP));
  });

  test("nothing to place", () => {
    expect(stackCards([], GAP)).toEqual([]);
  });
});
