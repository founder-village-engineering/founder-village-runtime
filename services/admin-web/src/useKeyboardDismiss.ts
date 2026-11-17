import { useEffect } from "react";

const keyboardInputTypes = new Set([
  "text",
  "search",
  "email",
  "password",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

function isTextEntry(element: Element | null): element is HTMLElement {
  return (
    (element instanceof HTMLInputElement &&
      keyboardInputTypes.has(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function targetsTextEntry(event: PointerEvent) {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        (isTextEntry(target) ||
          (target instanceof HTMLLabelElement && isTextEntry(target.control))),
    );
}

export function useKeyboardDismiss() {
  useEffect(() => {
    let tap: {
      pointerId: number;
      x: number;
      y: number;
      input: HTMLElement;
    } | null = null;
    const startTap = (event: PointerEvent) => {
      tap = null;
      if (!event.isPrimary || event.button !== 0 || targetsTextEntry(event))
        return;
      const active = document.activeElement;
      if (!isTextEntry(active)) return;
      tap = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        input: active,
      };
    };
    const cancelTap = () => {
      tap = null;
    };
    const dismissOnTap = (event: PointerEvent) => {
      if (!tap || tap.pointerId !== event.pointerId) return;
      const started = tap;
      tap = null;
      if (
        Math.hypot(event.clientX - started.x, event.clientY - started.y) <=
          10 &&
        document.activeElement === started.input &&
        !targetsTextEntry(event)
      )
        started.input.blur();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      const active = document.activeElement;
      if (isTextEntry(active)) active.blur();
    };

    // Capture covers all screens and portals without swallowing control actions.
    // Use a completed pointer tap, including surfaces without a click event.
    // Native touch scrolling cancels the pointer instead of dismissing input.
    document.addEventListener("pointerdown", startTap, true);
    document.addEventListener("pointerup", dismissOnTap, true);
    document.addEventListener("pointercancel", cancelTap, true);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", startTap, true);
      document.removeEventListener("pointerup", dismissOnTap, true);
      document.removeEventListener("pointercancel", cancelTap, true);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, []);
}
