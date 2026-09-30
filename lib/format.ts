export function shortAddress(value?: string | null, size = 4): string {
  if (!value) return "—";
  if (value.length <= 2 + size * 2 + 1) return value;
  return `${value.slice(0, 2 + size)}…${value.slice(-size)}`;
}

export function formatTime(timestamp?: bigint | number | null): string {
  if (timestamp === null || timestamp === undefined) return "—";
  const ms = Number(timestamp) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Copy that survives in-app wallet browsers. The async Clipboard API is
 * missing or permission-gated in several of them, so fall back to the old
 * selection trick rather than failing silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
