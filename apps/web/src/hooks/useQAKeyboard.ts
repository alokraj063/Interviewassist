import { useEffect } from "react";

export interface QAKeyboardHandlers {
  onNextCall?: () => void;
  onPrevCall?: () => void;
  onAccept?: () => void;
  onFocusOverride?: () => void;
  onNextTurn?: () => void;
  onPrevTurn?: () => void;
  onShowHelp?: () => void;
}

/**
 * Registers global keyboard shortcuts for the QA review workspace.
 * Shortcuts are suppressed while focus is inside an input, textarea, or
 * contenteditable element so typed characters are not swallowed.
 */
export function useQAKeyboard(handlers: QAKeyboardHandlers) {
  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;

      switch (e.key) {
        case "n":
          handlers.onNextCall?.();
          e.preventDefault();
          break;
        case "p":
          handlers.onPrevCall?.();
          e.preventDefault();
          break;
        case "a":
          handlers.onAccept?.();
          e.preventDefault();
          break;
        case "o":
          handlers.onFocusOverride?.();
          e.preventDefault();
          break;
        case "j":
          handlers.onNextTurn?.();
          e.preventDefault();
          break;
        case "k":
          handlers.onPrevTurn?.();
          e.preventDefault();
          break;
        case "?":
          handlers.onShowHelp?.();
          e.preventDefault();
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}

export const QA_SHORTCUTS = [
  { keys: "n", desc: "Next call" },
  { keys: "p", desc: "Previous call" },
  { keys: "a", desc: "Accept AI scoring" },
  { keys: "o", desc: "Focus override (first failed criterion)" },
  { keys: "j", desc: "Next transcript turn" },
  { keys: "k", desc: "Previous transcript turn" },
  { keys: "?", desc: "Show this help" },
];
