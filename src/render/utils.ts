import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function padToWidth(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return truncateToWidth(text, width);
  return text + " ".repeat(width - visible);
}

export function lineNumberCell(value?: number): string {
  return value == null ? "    " : String(value).padStart(4, " ");
}
