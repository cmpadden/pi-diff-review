import { matchesKey } from "@earendil-works/pi-tui";
import type { ReviewLine } from "./types.ts";

function getSearchableLineText(line: ReviewLine): string {
  return (
    line.kind === "add" || line.kind === "remove" || line.kind === "context"
      ? line.text.slice(1)
      : line.text
  ).toLocaleLowerCase();
}

export type SearchInputResult = {
  selected?: number;
};

export type SearchMatch = {
  lineIndex: number;
  start: number;
  end: number;
};

export class ReviewSearchState {
  mode = false;
  draftQuery = "";
  message = "";
  private _query = "";
  private activeMatchIndex = -1;

  constructor(private readonly lines: ReviewLine[]) {}

  get query(): string {
    return this._query;
  }

  set query(value: string) {
    this._query = value;
    this.activeMatchIndex = -1;
  }

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

    const matches = this.getMatches(query);
    if (matches.length === 0) {
      this.activeMatchIndex = -1;
      this.message = `No matches for /${query}`;
      return {};
    }

    this.message = "";
    let nextIndex: number;
    if (this.activeMatchIndex >= 0 && this.activeMatchIndex < matches.length) {
      nextIndex =
        (this.activeMatchIndex + direction + matches.length) % matches.length;
    } else {
      if (direction === 1) {
        nextIndex = matches.findIndex((match) => match.lineIndex >= selected);
      } else {
        nextIndex = -1;
        for (let index = matches.length - 1; index >= 0; index--) {
          if (matches[index]!.lineIndex <= selected) {
            nextIndex = index;
            break;
          }
        }
      }
      if (nextIndex < 0) nextIndex = direction === 1 ? 0 : matches.length - 1;
    }

    this.activeMatchIndex = nextIndex;
    return { selected: matches[nextIndex]!.lineIndex };
  }

  getStatusText(_selected: number): string {
    if (this.message) return this.message;
    if (!this.query) return "";

    const matches = this.getMatches(this.query);
    if (matches.length === 0) return `No matches for /${this.query}`;

    const position =
      this.activeMatchIndex >= 0 && this.activeMatchIndex < matches.length
        ? `${this.activeMatchIndex + 1}/${matches.length}`
        : `${matches.length} matches`;
    return `Search /${this.query} • ${position} • n next • N previous • Esc clear search`;
  }

  getMatchesForLine(lineIndex: number): SearchMatch[] {
    if (!this.query.trim()) return [];
    return this.getMatches(this.query).filter((match) => match.lineIndex === lineIndex);
  }

  getActiveMatch(): SearchMatch | undefined {
    if (!this.query.trim()) return undefined;
    const matches = this.getMatches(this.query);
    return this.activeMatchIndex >= 0 && this.activeMatchIndex < matches.length
      ? matches[this.activeMatchIndex]
      : undefined;
  }

  getHighlightCacheKey(): string {
    const active = this.getActiveMatch();
    return active
      ? `${this.query}\0${active.lineIndex}:${active.start}-${active.end}`
      : this.query;
  }

  private getMatches(query: string): SearchMatch[] {
    const needle = query.toLocaleLowerCase();
    if (!needle) return [];

    const matches: SearchMatch[] = [];
    this.lines.forEach((line, lineIndex) => {
      const haystack = getSearchableLineText(line);
      let start = haystack.indexOf(needle);
      while (start >= 0) {
        matches.push({ lineIndex, start, end: start + needle.length });
        start = haystack.indexOf(needle, start + needle.length);
      }
    });
    return matches;
  }
}
