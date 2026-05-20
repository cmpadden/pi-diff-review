import { matchesKey } from "@earendil-works/pi-tui";
import type { ReviewLine } from "./types.ts";

export type SearchInputResult = {
  selected?: number;
};

export class ReviewSearchState {
  mode = false;
  query = "";
  draftQuery = "";
  message = "";

  constructor(private readonly lines: ReviewLine[]) {}

  start(): void {
    this.mode = true;
    this.draftQuery = this.query;
    this.message = "";
  }

  handleInput(data: string, selected: number): SearchInputResult {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.mode = false;
      this.draftQuery = "";
      return {};
    }

    if (matchesKey(data, "enter")) {
      const query = this.draftQuery.trim();
      this.mode = false;
      this.draftQuery = "";
      this.query = query;
      this.message = "";
      return query ? this.jump(1, selected) : {};
    }

    if (matchesKey(data, "ctrl+u")) {
      this.draftQuery = "";
      return {};
    }

    if (matchesKey(data, "backspace") || data === "\u007f" || data === "\b") {
      this.draftQuery = this.draftQuery.slice(0, -1);
      return {};
    }

    if (data.length === 1 && data >= " " && data !== "\u007f") {
      this.draftQuery += data;
    }

    return {};
  }

  clear(): void {
    this.mode = false;
    this.query = "";
    this.draftQuery = "";
    this.message = "";
  }

  jump(direction: 1 | -1, selected: number): SearchInputResult {
    const query = this.query.trim();
    if (!query) return {};

    const matches = this.getMatchIndexes(query);
    if (matches.length === 0) {
      this.message = `No matches for /${query}`;
      return {};
    }

    this.message = "";
    const current =
      direction === 1
        ? matches.find((index) => index > selected)
        : [...matches].reverse().find((index) => index < selected);
    return {
      selected:
        current ??
        (direction === 1 ? matches[0]! : matches[matches.length - 1]!),
    };
  }

  getStatusText(selected: number): string {
    if (this.message) return this.message;
    if (!this.query) return "";

    const matches = this.getMatchIndexes(this.query);
    if (matches.length === 0) return `No matches for /${this.query}`;

    const current = matches.findIndex((index) => index === selected);
    const position =
      current >= 0
        ? `${current + 1}/${matches.length}`
        : `${matches.length} matches`;
    return `Search /${this.query} • ${position} • n next • N previous • Esc clear search`;
  }

  private getMatchIndexes(query: string): number[] {
    const needle = query.toLocaleLowerCase();
    if (!needle) return [];

    const matches: number[] = [];
    this.lines.forEach((line, index) => {
      if (line.text.toLocaleLowerCase().includes(needle)) matches.push(index);
    });
    return matches;
  }
}
