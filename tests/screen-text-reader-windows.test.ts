import { describe, expect, it } from "bun:test";
import {
  mapWindowsRole,
  parseWindowsFocusFrame,
} from "../src/screen-text-reader-windows.js";
import { FIELD_SEPARATOR } from "../src/screen-text-reader-subprocess.js";

const AT = "2026-09-03T12:00:00.000Z";
const record = (...fields: readonly string[]): string => fields.join(FIELD_SEPARATOR);

/**
 * The Windows reader's record contract, tested without a host.
 *
 * The script needs a real desktop and a real UI Automation client, so what CI can
 * hold to account is the pair on this side of the pipe: the six-field record and
 * the role mapping. Both are the places a change would quietly alter what the
 * projection believes.
 */
describe("parseWindowsFocusFrame", () => {
  it("reads the full record the sampling script writes", () => {
    const frame = parseWindowsFocusFrame(
      record("chrome", "30524", "Pull Request #172 - Google Chrome", "ControlType.Edit", "Search", "rebase develop"),
      AT,
    );

    expect(frame).toEqual({
      applicationId: "30524",
      applicationName: "chrome",
      windowTitle: "Pull Request #172 - Google Chrome",
      focusedRole: "text_input",
      focusedLabel: "Search",
      textContext: { prefix: "", suffix: "", selection: "rebase develop", language: null },
      occurredAt: AT,
    });
  });

  it("is quiet when the record names no addressable process", () => {
    // What a secure desktop answers: the script wrote a record, and there is no
    // process behind it. A quiet observation, not an error.
    expect(parseWindowsFocusFrame(record("", "", "", "", "", ""), AT)).toBeNull();
  });

  it("omits the fields the sample could not read, and keeps the ones it read as empty", () => {
    const frame = parseWindowsFocusFrame(record("explorer", "9001", "", "ControlType.Pane", "", ""), AT);

    // No window title and no selection: absent, because the backend has nothing
    // to report. A control type with an empty name: present as null, because the
    // element genuinely exposes no name — `projectFrame` tells those apart.
    expect(frame).toEqual({
      applicationId: "9001",
      applicationName: "explorer",
      focusedRole: "unknown",
      focusedLabel: null,
      occurredAt: AT,
    });
  });

  it("keeps a selection that contains the field separator", () => {
    // The separator is a control character, so UI text does not normally carry it
    // — but a selection is arbitrary text, and losing the whole sample to one
    // pasted control character would be the wrong trade.
    const selection = `left${FIELD_SEPARATOR}right`;
    const frame = parseWindowsFocusFrame(
      record("code", "42", "main.ts", "ControlType.Edit", "Editor", selection),
      AT,
    );

    expect(frame?.textContext?.selection).toBe(selection);
  });

  it("truncates a selection rather than persisting a select-all", () => {
    const frame = parseWindowsFocusFrame(
      record("code", "42", "main.ts", "ControlType.Edit", "Editor", "x".repeat(10_000)),
      AT,
    );

    expect(frame?.textContext?.selection.length).toBe(4_096);
  });

  it("omits the text context when nothing is selected", () => {
    const frame = parseWindowsFocusFrame(
      record("code", "42", "main.ts", "ControlType.Edit", "Editor", ""),
      AT,
    );

    expect(frame?.textContext).toBeUndefined();
  });
});

describe("mapWindowsRole", () => {
  it("maps the control types the protocol has a word for", () => {
    expect(mapWindowsRole("ControlType.Edit")).toBe("text_input");
    expect(mapWindowsRole("ControlType.Button")).toBe("button");
    expect(mapWindowsRole("ControlType.SplitButton")).toBe("button");
    expect(mapWindowsRole("ControlType.Hyperlink")).toBe("link");
  });

  it("refuses to call a document an editor", () => {
    // UIA gives a rendered web page and a word processor's canvas the same control
    // type, so "editor" would be a claim about editability that nothing in the
    // record supports.
    expect(mapWindowsRole("ControlType.Document")).toBe("unknown");
  });

  it("reads the type's tail, so an unfamiliar prefix is not silently unknown", () => {
    expect(mapWindowsRole("Edit")).toBe("text_input");
    expect(mapWindowsRole("Some.Future.Namespace.Button")).toBe("button");
    expect(mapWindowsRole("")).toBe("unknown");
  });
});
