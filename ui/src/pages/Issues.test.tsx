import { describe, expect, it } from "vitest";
import { buildIssuesSearchUrl, getNextIssuesPageLimit, hasMoreIssuesToRequest } from "./Issues";

describe("buildIssuesSearchUrl", () => {
  it("preserves trailing spaces in the synced search param", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug", "bug ")).toBe("/issues?q=bug+");
  });

  it("removes the search param when the input is cleared", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug#details", "")).toBe("/issues#details");
  });

  it("returns null when the URL already matches the current search", () => {
    expect(buildIssuesSearchUrl("http://localhost:3100/issues?q=bug+", "bug ")).toBeNull();
  });
});

describe("issues page pagination helpers", () => {
  it("increments issue list limits up to the server cap", () => {
    expect(getNextIssuesPageLimit(500)).toBe(750);
    expect(getNextIssuesPageLimit(750)).toBe(1000);
    expect(getNextIssuesPageLimit(1000)).toBe(1000);
  });

  it("requests another issue page only when the current server limit is full", () => {
    expect(hasMoreIssuesToRequest(499, 500)).toBe(false);
    expect(hasMoreIssuesToRequest(500, 500)).toBe(true);
    expect(hasMoreIssuesToRequest(1000, 1000)).toBe(false);
  });
});
