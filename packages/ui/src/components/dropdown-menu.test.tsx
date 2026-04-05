import { describe, expect, test } from "bun:test";
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu.js";

describe("dropdown menu wrappers", () => {
  test("simple wrappers expose the expected data slots", () => {
    const wrappers = [
      [DropdownMenu, "dropdown-menu"],
      [DropdownMenuPortal, "dropdown-menu-portal"],
      [DropdownMenuTrigger, "dropdown-menu-trigger"],
      [DropdownMenuGroup, "dropdown-menu-group"],
      [DropdownMenuRadioGroup, "dropdown-menu-radio-group"],
      [DropdownMenuSub, "dropdown-menu-sub"],
    ] as const;

    for (const [Component, slot] of wrappers) {
      const element = Component({});
      expect(element.props["data-slot"]).toBe(slot);
    }
  });

  test("content, labels, and items merge classes and positioning defaults", () => {
    const content = DropdownMenuContent({ className: "extra" });
    const positioner = content.props.children;
    const popup = positioner.props.children;

    expect(positioner.props.align).toBe("start");
    expect(positioner.props.alignOffset).toBe(0);
    expect(positioner.props.side).toBe("bottom");
    expect(positioner.props.sideOffset).toBe(4);
    expect(popup.props["data-slot"]).toBe("dropdown-menu-content");
    expect(popup.props.className).toContain("min-w-32");
    expect(popup.props.className).toContain("extra");

    const label = DropdownMenuLabel({ inset: true, className: "extra" });
    expect(label.props["data-slot"]).toBe("dropdown-menu-label");
    expect(label.props["data-inset"]).toBe(true);
    expect(label.props.className).toContain("data-inset:pl-7");
    expect(label.props.className).toContain("extra");

    const item = DropdownMenuItem({
      inset: true,
      variant: "destructive",
      className: "extra",
    });
    expect(item.props["data-slot"]).toBe("dropdown-menu-item");
    expect(item.props["data-inset"]).toBe(true);
    expect(item.props["data-variant"]).toBe("destructive");
    expect(item.props.className).toContain("data-[variant=destructive]:text-destructive");
    expect(item.props.className).toContain("extra");
  });

  test("submenu, checkbox, radio, separator, and shortcut wrappers preserve their indicators", () => {
    const subTrigger = DropdownMenuSubTrigger({
      inset: true,
      className: "extra",
      children: "More",
    });
    const subTriggerChildren = Array.isArray(subTrigger.props.children)
      ? subTrigger.props.children
      : [subTrigger.props.children];
    expect(subTrigger.props["data-slot"]).toBe("dropdown-menu-sub-trigger");
    expect(subTrigger.props["data-inset"]).toBe(true);
    expect(subTrigger.props.className).toContain("data-popup-open:bg-accent");
    expect(subTrigger.props.className).toContain("extra");
    expect(subTriggerChildren).toHaveLength(2);

    const subContent = DropdownMenuSubContent({ className: "extra" });
    expect(subContent.props["data-slot"]).toBe("dropdown-menu-sub-content");
    const renderedSubContent = subContent.type(subContent.props);
    const subPositioner = renderedSubContent.props.children;
    const subPopup = subPositioner.props.children;
    expect(subPositioner.props.alignOffset).toBe(-3);
    expect(subPositioner.props.side).toBe("right");
    expect(subPopup.props.className).toContain("min-w-[96px]");
    expect(subPopup.props.className).toContain("extra");

    const checkboxItem = DropdownMenuCheckboxItem({
      checked: true,
      inset: true,
      className: "extra",
      children: "Checked",
    });
    expect(checkboxItem.props["data-slot"]).toBe("dropdown-menu-checkbox-item");
    expect(checkboxItem.props["data-inset"]).toBe(true);
    expect(checkboxItem.props.className).toContain("pr-8");
    expect(checkboxItem.props.className).toContain("extra");
    const checkboxChildren = Array.isArray(checkboxItem.props.children)
      ? checkboxItem.props.children
      : [checkboxItem.props.children];
    expect(checkboxChildren[0].props["data-slot"]).toBe("dropdown-menu-checkbox-item-indicator");

    const radioItem = DropdownMenuRadioItem({
      inset: true,
      className: "extra",
      children: "Choice",
      value: "one",
    });
    expect(radioItem.props["data-slot"]).toBe("dropdown-menu-radio-item");
    expect(radioItem.props["data-inset"]).toBe(true);
    expect(radioItem.props.className).toContain("pr-8");
    expect(radioItem.props.className).toContain("extra");
    const radioChildren = Array.isArray(radioItem.props.children)
      ? radioItem.props.children
      : [radioItem.props.children];
    expect(radioChildren[0].props["data-slot"]).toBe("dropdown-menu-radio-item-indicator");

    const separator = DropdownMenuSeparator({ className: "extra" });
    expect(separator.props["data-slot"]).toBe("dropdown-menu-separator");
    expect(separator.props.className).toContain("bg-border");
    expect(separator.props.className).toContain("extra");

    const shortcut = DropdownMenuShortcut({ className: "extra", children: "⌘K" });
    expect(shortcut.props["data-slot"]).toBe("dropdown-menu-shortcut");
    expect(shortcut.props.className).toContain("tracking-widest");
    expect(shortcut.props.className).toContain("extra");
    expect(shortcut.props.children).toBe("⌘K");
  });
});
