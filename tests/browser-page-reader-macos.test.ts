import { describe, expect, it } from "bun:test";
import { parseBrowserFrame } from "../src/browser-page-reader-macos.js";

/**
 * The parser is the only part of the darwin backend that can run in CI: the
 * subprocess half needs a Mac with automation grants. What these tests buy is
 * confidence that the field layout — pid, title, URL, separated by US — is
 * decoded exactly as the AppleScript writes it, including the hostile cases a
 * real desktop produces.
 */
describe("parseBrowserFrame", () => {
  // The unit separator written as an escape so this file never carries a raw
  // control byte (git would call it binary and grep would go blind).
  const US = "\u001F";

  it("decodes a full frame", () => {
    expect(parseBrowserFrame(`742${US}GitHub - squid${US}https://github.com/example/squid\n`))
      .toEqual({
        url: "https://github.com/example/squid",
        title: "GitHub - squid",
        owner: { applicationId: "742", windowTitle: "GitHub - squid" },
      });
  });

  it("trims the trailing newline osascript appends", () => {
    const withNewline = `9${US}${US}https://example.com/\n`;
    const without = `9${US}${US}https://example.com/`;
    expect(parseBrowserFrame(withNewline)).toEqual(parseBrowserFrame(without));
  });

  it("returns null when there is no owning process", () => {
    // No URL-bearing window can be attributed to nothing. The reducer drops
    // ownerless pages anyway; refusing here keeps the frame out entirely.
    expect(parseBrowserFrame(`${US}Some Title${US}https://example.com/`)).toBeNull();
  });

  it("returns null when there is no page URL", () => {
    // Most foreground windows are not browsers at all — an editor or terminal
    // is a quiet observation, not an error.
    expect(parseBrowserFrame(`742${US}Untitled — TextEdit${US}`)).toBeNull();
  });

  it("returns null when fewer fields arrive than the script emits", () => {
    // A truncated line is a protocol violation from our own script, not a page.
    expect(parseBrowserFrame(`742${US}just a title`)).toBeNull();
    expect(parseBrowserFrame("")).toBeNull();
  });

  it("keeps a title that itself contains the separator", () => {
    // Titles are user content and may contain anything; positional decoding
    // (pid first, URL last) rejoins them instead of shifting fields.
    const hostileTitle = `Docs${US}Setup | notes`;
    const frame = parseBrowserFrame(`55${US}${hostileTitle}${US}https://docs.example.com/`);
    expect(frame?.title).toBe(hostileTitle);
    expect(frame?.url).toBe("https://docs.example.com/");
  });

  it("reports an empty title as absent rather than empty", () => {
    // osascript cannot distinguish "unreadable" from "empty"; inventing ""
    // would misrepresent that ambiguity as a fact.
    const frame = parseBrowserFrame(`742${US}${US}https://example.com/`);
    expect(frame).not.toBeNull();
    expect(frame?.title).toBeUndefined();
    expect(frame?.owner?.windowTitle).toBe("");
  });
});
