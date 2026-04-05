import { describe, expect, test } from "bun:test";
import { Button, buttonVariants } from "./button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.js";
import { Checkbox } from "./checkbox.js";
import { Input } from "./input.js";
import { Label } from "./label.js";
import { Skeleton } from "./skeleton.js";

describe("ui components", () => {
  test("buttonVariants exposes expected defaults and overrides", () => {
    expect(buttonVariants()).toContain("bg-primary");
    expect(buttonVariants({ variant: "outline", size: "sm" })).toContain("border-border");
    expect(buttonVariants({ variant: "outline", size: "sm" })).toContain("h-7");
  });

  test("Button returns a button primitive element with merged classes", () => {
    const element = Button({
      variant: "outline",
      size: "sm",
      className: "extra",
      children: "Save",
    });

    expect(element.props["data-slot"]).toBe("button");
    expect(element.props.className).toContain("border-border");
    expect(element.props.className).toContain("h-7");
    expect(element.props.className).toContain("extra");
    expect(element.props.children).toBe("Save");
  });

  test("Card wrappers attach slots, sizing, and merged class names", () => {
    const card = Card({
      size: "sm",
      className: "extra",
      children: "body",
    });

    expect(card.props["data-slot"]).toBe("card");
    expect(card.props["data-size"]).toBe("sm");
    expect(card.props.className).toContain("group/card");
    expect(card.props.className).toContain("extra");

    const wrappers = [
      [CardHeader, "card-header", "px-4"],
      [CardTitle, "card-title", "text-sm"],
      [CardDescription, "card-description", "text-muted-foreground"],
      [CardAction, "card-action", "justify-self-end"],
      [CardContent, "card-content", "px-4"],
      [CardFooter, "card-footer", "border-t"],
    ] as const;

    for (const [Component, slot, token] of wrappers) {
      const element = Component({ className: "extra" });
      expect(element.props["data-slot"]).toBe(slot);
      expect(element.props.className).toContain(token);
      expect(element.props.className).toContain("extra");
    }
  });

  test("Input, Label, and Skeleton expose expected slots and props", () => {
    const input = Input({
      type: "email",
      className: "extra",
      placeholder: "Email",
    });
    expect(input.props["data-slot"]).toBe("input");
    expect(input.props.type).toBe("email");
    expect(input.props.className).toContain("extra");

    const label = Label({
      className: "extra",
      children: "Email",
    });
    expect(label.props["data-slot"]).toBe("label");
    expect(label.props.className).toContain("gap-2");
    expect(label.props.className).toContain("extra");

    const skeleton = Skeleton({ className: "extra" });
    expect(skeleton.props["data-slot"]).toBe("skeleton");
    expect(skeleton.props.className).toContain("animate-pulse");
    expect(skeleton.props.className).toContain("extra");
  });

  test("Checkbox returns indicator markup inside the root primitive", () => {
    const checkbox = Checkbox({
      className: "extra",
    });

    expect(checkbox.props["data-slot"]).toBe("checkbox");
    expect(checkbox.props.className).toContain("peer");
    expect(checkbox.props.className).toContain("extra");
    expect(checkbox.props.children.props["data-slot"]).toBe("checkbox-indicator");
  });
});
