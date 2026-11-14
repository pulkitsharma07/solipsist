// `restoreSource`: what the writer didn't change stays byte for byte. The pages are what repos really hold (their
// own conventions), not what Solipsist writes.
import { describe, expect, test } from "bun:test";
import { canonical, restoreSource, splitFrontmatter } from "../src/shared/docfile";

const REPO: Record<string, string> = {
  readme: `<p align="center"><img src="docs/logo.png" width="120" alt="Logo"></p>

# Trailhead

[![CI](https://img.shields.io/badge/ci-green)](https://example.com/ci) [![MIT](https://img.shields.io/badge/mit-blue)](LICENSE)

> [!NOTE]
> Start with the [roadmap](ROADMAP.md).

| What | Where |
|---|---|
| Decisions | [docs/decisions/](docs/decisions/) |

<details>
<summary>Setup</summary>

\`\`\`bash
bun install
\`\`\`

</details>
`,
  roadmap: `# Roadmap

_Last reviewed 2026-11-02._

## Now

- [x] Offline tiles ([plan](docs/plans/offline.md))
- [ ] Saved routes ([task](<backlog/tasks/task-12 - Sync saved routes.md>))
- [ ] Billing

## Later

* Garmin export
* Trail conditions
`,
  todo: `# TODO

### In Progress

- [ ] Fix the chart #fe @maya
  - [x] Reproduce it
  - [ ] Patch the path builder

### Todo

- [ ] Rate-limit the proxy ~2h #be
`,
  changelog: `# Changelog

## [Unreleased]

### Added
- Saved routes.

## [0.3.0] - 2026-10-14

[Unreleased]: https://example.com/compare/v0.3.0...HEAD
[0.3.0]: https://example.com/releases/tag/v0.3.0
`,
  spec: `# Tasks

- [X] T001 Create the table in src/db/schema.ts
- [ ] T002 [P] Add POST /routes
- [ ] T003 [P] [US1] Save button

- **FR-002**: System MUST sync routes [NEEDS CLARIFICATION: on cellular?]
`,
  footnote: `Footnotes work on GitHub[^1].

[^1]: Since 2021.
`,
  plan: `# ExecPlan

- Decision: use Stripe Checkout.
  Rationale: smallest PCI scope.
  Date/Author: 2026-10-29 / maya
`,
  backlog: `## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Routes upload on save
- [ ] #2 Conflicts keep both copies
<!-- AC:END -->
`,
};

/** Lines of `b` that `a` doesn't have, and the other way round. */
const changed = (a: string, b: string) => {
  const [x, y] = [a.split("\n"), b.split("\n")];
  const [sx, sy] = [new Set(x), new Set(y)];
  return [...y.filter((l) => !sx.has(l)), ...x.filter((l) => !sy.has(l))];
};

describe("restoreSource", () => {
  for (const [name, page] of Object.entries(REPO)) {
    test(`${name}: no edit gives back every byte`, () => {
      expect(restoreSource(page, canonical(page))).toEqual({ text: page, fallback: false });
    });

    test(`${name}: a paragraph added at the end changes nothing else`, () => {
      const { text, fallback } = restoreSource(page, `${canonical(page)}\n\nAdded.`);
      expect(fallback).toBe(false);
      expect(changed(page, text)).toEqual(["Added."]);
    });
  }

  test("ticking one box in a task list leaves the other items as they were", () => {
    const body = canonical(REPO.spec!).replace("- [ ] T002", "- [x] T002");
    const { text } = restoreSource(REPO.spec!, body);
    expect(changed(REPO.spec!, text).sort()).toEqual(["- [ ] T002 [P] Add POST /routes", "- [x] T002 [P] Add POST /routes"].sort());
    expect(text).toContain("- [X] T001");
  });

  test("an item edited in a list of another marker rewrites that list only", () => {
    const body = canonical(REPO.roadmap!).replace("- Garmin export", "- Garmin and Wahoo export");
    const { text, fallback } = restoreSource(REPO.roadmap!, body);
    expect(fallback).toBe(false);
    expect(text).toContain("- Garmin and Wahoo export\n- Trail conditions");
    expect(text).toContain("_Last reviewed");
  });

  test("a reference link stays a reference, and its definition stays where it was", () => {
    const body = `${canonical(REPO.changelog!)}\n\nMore.`;
    const { text } = restoreSource(REPO.changelog!, body);
    expect(text).toContain("## [Unreleased]\n");
    expect(text).toContain("[0.3.0]: https://example.com/releases/tag/v0.3.0");
  });

  test("removing a block removes only it", () => {
    const body = canonical(REPO.todo!).replace("### Todo\n\n- [ ] Rate-limit the proxy ~2h #be", "").trimEnd();
    const { text, fallback } = restoreSource(REPO.todo!, body);
    expect(fallback).toBe(false);
    expect(text).not.toContain("Rate-limit");
    expect(text).toContain("  - [x] Reproduce it");
  });

  test("blocks moved past each other still read as the writer has them", () => {
    const page = "One *a*.\n\nTwo *b*.\n\nThree *c*.\n";
    const { text, fallback } = restoreSource(page, "Three *c*.\n\nOne *a*.\n\nTwo *b*.");
    expect(fallback).toBe(false);
    expect(canonical(text)).toBe(canonical("Three *c*.\n\nOne *a*.\n\nTwo *b*."));
  });

  test("a CRLF file stays CRLF", () => {
    const page = "# T\r\n\r\nOne.\r\n\r\nTwo.\r\n";
    const { text } = restoreSource(page, "# T\n\nOne.\n\nTwo changed.");
    expect(text).toBe("# T\r\n\r\nOne.\r\n\r\nTwo changed.\r\n");
  });

  test("the file's own ending is kept", () => {
    expect(restoreSource("# T\n\nOne.", "# T\n\nOne.").text).toBe("# T\n\nOne.");
    expect(restoreSource("# T\n\nOne.\n\n", "# T\n\nOne.").text).toBe("# T\n\nOne.\n\n");
  });

  test("the blank line after frontmatter is kept", () => {
    const { frontmatter, body } = splitFrontmatter("---\na: 1\n---\n\n# T\n");
    expect(frontmatter + restoreSource(body, canonical(body)).text).toBe("---\na: 1\n---\n\n# T\n");
  });

  test("everything can go", () => {
    expect(canonical(restoreSource("# T\n", "").text)).toBe("");
  });
});

describe("splitFrontmatter", () => {
  test("a YAML mapping at the very start, through its closing line", () => {
    expect(splitFrontmatter("---\nstatus: accepted\n---\n\n# T\n")).toEqual({ frontmatter: "---\nstatus: accepted\n---\n", body: "\n# T\n" });
  });

  test("a CRLF block is frontmatter too", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nBody").frontmatter).toBe("---\r\na: 1\r\n---\r\n");
  });

  test("anything else is a rule and text", () => {
    for (const src of ["---\n\nA rule.\n\n---\n", "Text\n---\na: 1\n---\n", "---\nnot closed\n", "---\n- a\n- b\n---\n", "---\n---\n"]) {
      expect(splitFrontmatter(src)).toEqual({ frontmatter: "", body: src });
    }
  });
});
