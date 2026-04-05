import { describe, expect, test } from "bun:test";
import { cn } from "./utils.js";

describe("cn", () => {
  test("merges class names and resolves tailwind conflicts", () => {
    expect(
      cn("px-2 text-xs", undefined, false, ["font-medium", "px-4"], { hidden: false, block: true }),
    ).toBe("text-xs font-medium px-4 block");
  });

  test("keeps non-conflicting classes intact", () => {
    expect(cn("border", "bg-background", "hover:bg-muted")).toBe(
      "border bg-background hover:bg-muted",
    );
  });
});
