/** A card in a margin column: where its passage would like it (`top`, column pixels) and how tall it is. */
export interface CardBox { top: number; height: number }

/**
 * Where each card in a margin column goes, in the order given: as level with its passage as it can be, none touching.
 * Cards that would collide share the difference: the group is centred on where its cards want to be, so a cluster
 * spreads above and below its passages rather than running down the page past them. Never above `min`.
 */
export function stackCards(cards: CardBox[], gap: number, min = 0): number[] {
  type Group = { top: number; height: number; at: number[]; wanted: number };
  const order = cards.map((_, i) => i).sort((a, b) => cards[a]!.top - cards[b]!.top);
  const groups: Group[] = [];
  for (const i of order) {
    const { top, height } = cards[i]!;
    let g: Group = { top: Math.max(min, top), height, at: [i], wanted: top };
    // Joining a group can move it up into the one before, so this runs until nothing touches.
    for (let prev = groups.at(-1); prev && prev.top + prev.height + gap > g.top; prev = groups.at(-1)) {
      groups.pop();
      const at = [...prev.at, ...g.at];
      // `wanted` is the sum, over the group's cards, of where each would put the group's top.
      const wanted = prev.wanted + g.wanted - g.at.length * (prev.height + gap);
      g = { top: Math.max(min, wanted / at.length), height: prev.height + gap + g.height, at, wanted };
    }
    groups.push(g);
  }
  const tops = new Array<number>(cards.length);
  for (const g of groups) {
    let y = g.top;
    for (const i of g.at) { tops[i] = Math.round(y); y += cards[i]!.height + gap; }
  }
  return tops;
}
