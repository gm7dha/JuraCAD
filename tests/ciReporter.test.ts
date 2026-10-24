import { describe, expect, it } from "vitest";
import { collectFailures, countTests, crashHint, escapeData, escapeProperty, lineIn } from "./support/ciReporter";

describe("CI reporter", () => {
  it("escapes text for GitHub annotations", () => {
    expect(escapeData("50% done\nnext")).toBe("50%25 done%0Anext");
    expect(escapeProperty("a › b: c, d")).toBe("a › b%3A c%2C d");
  });

  it("finds the line in the test file an error points at", () => {
    const stack = "Error: no\n    at m (/x/node_modules/vitest/index.js:11:47)\n    at Object.fn (/repo/tests/engine.test.ts:1605:19)";
    expect(lineIn(stack, "/repo/tests/engine.test.ts")).toBe(1605);
    expect(lineIn(stack, "/repo/tests/other.test.ts")).toBeUndefined();
    expect(lineIn(undefined, "/repo/tests/engine.test.ts")).toBeUndefined();
  });

  it("lists failed tests with their full names", () => {
    const file = {
      name: "tests/a.test.ts",
      type: "suite",
      filepath: "/repo/tests/a.test.ts",
      result: { state: "fail" },
      tasks: [
        {
          name: "group",
          type: "suite",
          result: { state: "fail" },
          tasks: [
            { name: "works", type: "test", result: { state: "pass" } },
            { name: "breaks", type: "test", result: { state: "fail", errors: [{ message: "expected 1 to be 2", stack: "Error\n    at /repo/tests/a.test.ts:12:5" }] } },
          ],
        },
      ],
    };
    const f = collectFailures([file], [], "/repo");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: "tests/a.test.ts", line: 12, title: "group › breaks" });
    expect(f[0].text).toMatch(/expected 1 to be 2/);
    expect(countTests([file])).toEqual({ tests: 2, failed: 1, skipped: 0 });
  });

  it("reports crashed test processes and unfinished files, which have no test to point at", () => {
    const crashed = { name: "b", type: "suite", filepath: "/repo/tests/b.test.ts", result: { state: "fail", errors: [{ message: "Worker exited unexpectedly" }] }, tasks: [] };
    const unfinished = { name: "c", type: "suite", filepath: "/repo/tests/c.test.ts", result: { state: "run" }, tasks: [] };
    const f = collectFailures([crashed, unfinished], [{ name: "Error", message: "Channel closed" }], "/repo");
    expect(f.map((x) => x.title)).toEqual(["tests/b.test.ts (whole file)", "tests/c.test.ts didn't finish", "Unhandled error (Error)"]);
    expect(f[0].text).toMatch(/ran out of memory/);
    expect(f[2].text).toMatch(/Channel closed/);
  });

  it("explains out-of-memory crashes", () => {
    expect(crashHint("FATAL ERROR: Reached heap limit Allocation failed")).toMatch(/memory/);
    expect(crashHint("expected 1 to be 2")).toBe("");
  });
});
