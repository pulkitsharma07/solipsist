// Markers move from pending to ack to done when the markdown file says so; the page's loaders follow, in place.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Server } from "./sim";
import { Tab } from "./browser-tab";
import { resetAcks } from "../src/server/put";
import { blockKey, diffBodies, docToMarkdown, markdownToDoc, taskStates, withoutStates } from "../src/shared/docfile";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  document.body.innerHTML = "";
});
// A popup opens only for a loader that is in the document.
const attach = (tab: Tab) => { document.body.append(tab.editor.view.dom.parentElement ?? tab.editor.view.dom); return tab; };

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

describe("the markdown", () => {
  test("a gen marker and a sel range keep their state through load and save", () => {
    for (const s of ["", ":ack", ":sug", ":done", ":btn"]) {
      const md = `Write <!-- gen:abc${s} --> here, and <!-- sel:xyz${s} -->this<!-- /sel:xyz${s} --> too.`;
      expect(roundTrip(md)).toBe(md);
    }
  });

  test("the state is read from the opening comment of a pair, and written to both", () => {
    expect(roundTrip("a <!-- sel:xyz:done -->b<!-- /sel:xyz -->")).toBe("a <!-- sel:xyz:done -->b<!-- /sel:xyz:done -->");
    expect(roundTrip("a <!-- sel:xyz -->b<!-- /sel:xyz:done -->")).toBe("a <!-- sel:xyz -->b<!-- /sel:xyz -->");
  });

  test("the parsed nodes and marks carry the state", () => {
    const json = JSON.stringify(markdownToDoc("x <!-- gen:abc:ack --> <!-- sel:xyz:done -->y<!-- /sel:xyz:done -->").toJSON());
    expect(json).toContain('"markerPoint","attrs":{"taskType":"gen","id":"abc","state":"ack","instruction":null}');
    expect(json).toContain('"markerRange","attrs":{"taskType":"sel","id":"xyz","state":"done","instruction":null}');
  });

  test("an unknown suffix is not a placeholder; it stays as the text it is", () => {
    expect(roundTrip("a <!-- gen:abc:later --> b")).not.toContain("markerPoint");
    expect(JSON.stringify(markdownToDoc("a <!-- gen:abc:later --> b").toJSON())).not.toContain("markerPoint");
  });

  test("a suggestion waiting is the sug state, on a point and on every pair of a range over several blocks", () => {
    const md = "a <!-- gen:abc:sug --> b\n\n<!-- sel:xyz:sug -->one<!-- /sel:xyz:sug -->\n\n<!-- sel:xyz:sug -->two<!-- /sel:xyz:sug -->";
    expect(roundTrip(md)).toBe(md);
    expect([...taskStates(md)]).toEqual([["abc", "sug"], ["xyz", "sug"]]);
    const json = JSON.stringify(markdownToDoc(md).toJSON());
    expect(json).toContain('"markerPoint","attrs":{"taskType":"gen","id":"abc","state":"sug","instruction":null}');
    expect(json).toContain('"markerRange","attrs":{"taskType":"sel","id":"xyz","state":"sug","instruction":null}');
    // a stand-in's state code can't be read as the old one-letter forms (`s` once started a range)
    expect(roundTrip("x <!-- gen:sss:sug --> <!-- sel:sab:sug -->y<!-- /sel:sab:sug -->")).toBe("x <!-- gen:sss:sug --> <!-- sel:sab:sug -->y<!-- /sel:sab:sug -->");
  });

  test("a sug placeholder is further along than ack: one opening at sug is enough", () => {
    expect(taskStates("<!-- sel:abc:ack -->a<!-- /sel:abc:ack -->\n\n<!-- sel:abc:sug -->b<!-- /sel:abc:sug -->").get("abc")).toBe("sug");
    expect(diffBodies("x <!-- gen:qqq:ack --> y", "x <!-- gen:qqq:sug --> y")).toEqual([]);
  });

  test("taskStates lists each id's state", () => {
    const md = "<!-- gen:aaa -->\n\n<!-- gen:bbb:ack -->\n\n<!-- sel:ccc:done -->x<!-- /sel:ccc:done -->";
    expect([...taskStates(md)]).toEqual([["aaa", "pending"], ["bbb", "ack"], ["ccc", "done"]]);
    expect(withoutStates(md)).toBe("<!-- gen:aaa -->\n\n<!-- gen:bbb -->\n\n<!-- sel:ccc -->x<!-- /sel:ccc -->");
  });

  test("an id with several pairs (one range over several paragraphs) takes the furthest state of its openings", () => {
    const md = "<!-- sel:abc:ack -->a<!-- /sel:abc -->\n\n<!-- sel:abc -->b<!-- /sel:abc -->";
    expect(taskStates(md).get("abc")).toBe("ack");
    expect(taskStates("<!-- sel:abc -->a<!-- /sel:abc -->\n\n<!-- sel:abc:done -->b<!-- /sel:abc:done -->").get("abc")).toBe("done");
  });

  test("moving a placeholder on is not a change: same block key, no diff", () => {
    const a = "Para <!-- gen:abc --> end.";
    const b = "Para <!-- gen:abc:done --> end.";
    const key = (md: string) => blockKey(markdownToDoc(md).toJSON().content![0]!);
    expect(key(a)).toBe(key(b));
    expect(diffBodies(a, b)).toEqual([]);
    expect(diffBodies("x <!-- sel:qqq:ack -->y<!-- /sel:qqq:ack -->", "x <!-- sel:qqq:done -->y<!-- /sel:qqq:done -->")).toEqual([]);
  });
});

describe("the page", () => {
  const BODY = "# Plan\n\nFirst <!-- gen:aaa --> paragraph.\n\nSecond <!-- sel:bbb -->bit<!-- /sel:bbb --> here.";
  const setup = async () => {
    const server = new Server(BODY);
    const tab = attach(new Tab(server.src));
    await tab.save(server);
    return { server, tab };
  };
  const loader = (tab: Tab, id: string) => tab.editor.view.dom.querySelector<HTMLElement>(`.task-loader[data-id="${id}"]`)!;
  const faces = (el: HTMLElement) => [...el.querySelectorAll(".task-face")];
  const popup = () => document.querySelector<HTMLElement>(".task-popup");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const moveOn = (server: Server, tab: Tab, from: string, to: string) => {
    server.handEdit((md) => md.replaceAll(from, to));
    return tab.receive(server.src);
  };

  test("both kinds start out waiting, with the blinking dot", async () => {
    const { tab } = await setup();
    for (const id of ["aaa", "bbb"]) {
      expect(loader(tab, id).dataset.state).toBe("pending");
      expect(loader(tab, id).querySelector("svg.gen-dot animate")).not.toBeNull();
    }
  });

  test("ack: the loader changes in place to the spinner, with no review and no unsaved change", async () => {
    const { server, tab } = await setup();
    const el = loader(tab, "aaa");
    expect(moveOn(server, tab, "<!-- gen:aaa -->", "<!-- gen:aaa:ack -->")).toBe("reloaded");
    expect(tab.session.getSnapshot().save).toBe("saved");
    expect(loader(tab, "aaa")).toBe(el); // the same element: that is what lets it fade from one picture to the next
    expect(el.dataset.state).toBe("ack");
    expect(faces(el).some((f) => f.classList.contains("leave") && f.querySelector(".gen-dot"))).toBe(true);
    expect(el.querySelector(".task-face.enter svg.gen-spinner animateTransform")).not.toBeNull();
    await wait(300);
    expect(faces(el)).toHaveLength(1);
    expect(tab.markdown).toContain("<!-- gen:aaa:ack -->");
  });

  test("a stale ack reset by the server goes back to the blinking dot, in place, with no review", async () => {
    const { server, tab } = await setup();
    moveOn(server, tab, "<!-- gen:aaa -->", "<!-- gen:aaa:ack -->");
    const el = loader(tab, "aaa");
    server.src = resetAcks(server.src)!.file;
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.session.getSnapshot().save).toBe("saved");
    expect(loader(tab, "aaa")).toBe(el);
    expect(el.dataset.state).toBe("pending");
    expect(tab.markdown).toContain("<!-- gen:aaa -->");
  });

  test("a sel range follows too: its widget keeps its element and its text gets the state", async () => {
    const { server, tab } = await setup();
    const el = loader(tab, "bbb");
    moveOn(server, tab, "<!-- sel:bbb -->", "<!-- sel:bbb:ack -->");
    moveOn(server, tab, "<!-- /sel:bbb -->", "<!-- /sel:bbb:ack -->");
    expect(loader(tab, "bbb")).toBe(el);
    expect(el.dataset.state).toBe("ack");
    expect(tab.editor.view.dom.querySelector('.task-range[data-state="ack"]')?.textContent).toBe("bit");
    expect(tab.markdown).toContain("<!-- sel:bbb:ack -->bit<!-- /sel:bbb:ack -->");
  });

  test("done shows no picture and no popup, whether it is reached live or loaded that way", async () => {
    const { server, tab } = await setup();
    moveOn(server, tab, "<!-- gen:aaa -->", "<!-- gen:aaa:ack -->");
    moveOn(server, tab, "<!-- gen:aaa:ack -->", "<!-- gen:aaa:done -->");
    const el = loader(tab, "aaa");
    expect(el.dataset.state).toBe("done");
    await wait(300);
    expect(el.querySelector("svg")).toBeNull();
    expect(el.getAttribute("role")).toBeNull();
    el.click();
    expect(popup()).toBeNull();
    const loaded = attach(new Tab(new Server("# T\n\nText <!-- gen:zzz:done --> more.").src));
    expect(loader(loaded, "zzz").dataset.state).toBe("done");
    expect(loader(loaded, "zzz").querySelector("svg")).toBeNull();
  });

  test("a range over several paragraphs moves on when only one of its comments is edited", async () => {
    const server = new Server("# T\n\n1. <!-- sel:abc -->one<!-- /sel:abc -->\n2. <!-- sel:abc -->two<!-- /sel:abc -->");
    const tab = attach(new Tab(server.src));
    await tab.save(server);
    moveOn(server, tab, "<!-- sel:abc -->one", "<!-- sel:abc:ack -->one");
    expect([...tab.editor.view.dom.querySelectorAll(".task-range")].map((e) => (e as HTMLElement).dataset.state)).toEqual(["ack", "ack"]);
    expect(loader(tab, "abc").dataset.state).toBe("ack");
  });

  test("while the writer types, a placeholder that is done and the content added with it both arrive, without a clash", async () => {
    {
      const { server, tab } = await setup();
      tab.typeAfter("First", " typed");
      server.handEdit((md) => md.replace("<!-- gen:aaa -->", "<!-- gen:aaa:done -->").replace("Second", "Added by the agent.\n\nSecond"));
      tab.receive(server.src);
      const snap = tab.session.getSnapshot();
      expect(snap.conflict).toBe(false);
      expect(tab.markdown).toContain("Added by the agent.");
      expect(tab.markdown).toContain("First typed");
      expect(loader(tab, "aaa").dataset.state).toBe("done");
      await wait(450);
      expect(popup()).toBeNull();
    }
  });

  test("a state change lands in place", async () => {
    const { server, tab } = await setup();
    const el = loader(tab, "aaa");
    moveOn(server, tab, "<!-- gen:aaa -->", "<!-- gen:aaa:done -->");
    expect(loader(tab, "aaa")).toBe(el);
    expect(el.dataset.state).toBe("done");
  });

  test("unsaved typing is kept while a placeholder moves on", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("First", " typed");
    moveOn(server, tab, "<!-- gen:aaa -->", "<!-- gen:aaa:ack -->");
    expect(tab.markdown).toContain("First typed");
    expect(loader(tab, "aaa").dataset.state).toBe("ack");
  });
});
