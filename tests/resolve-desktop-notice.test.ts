import { describe, expect, it } from "bun:test";
import { resolveDesktopNotice } from "../src/resolve-desktop-notice.js";

/**
 * Speaking up defaults to on, wherever the host has a backend. The browser
 * reader is off by default because observing costs privacy; a notice observes
 * nothing — it repeats on the desktop what the panel already showed. What a
 * notice spends is attention, and the setting exists so the person can decline
 * to spend it, by naming `off` rather than by knowing that empty means quiet.
 */
describe("resolveDesktopNotice", () => {
  it("speaks by default on every host with a backend", () => {
    for (const platform of ["linux", "win32"] as const) {
      const resolved = resolveDesktopNotice({ env: {}, platform });
      if ("configError" in resolved) throw new Error(resolved.configError);
      if (!resolved.enabled) throw new Error(`expected the default to speak on ${platform}`);
      expect(resolved.noticeKind).toBe("desktop");
      expect(typeof resolved.notifierFactory).toBe("function");
    }
  });

  it("is quiet by default where no backend exists, without a refusal", () => {
    // A default has to be livable on every host: unset on macOS starts the run,
    // silent. One machine's missing backend must not turn a default into an
    // exit — that is the value-a-form-cannot-satisfy defect, reached through
    // the resolver instead of the form.
    for (const platform of ["darwin", "freebsd"] as const) {
      expect(resolveDesktopNotice({ env: {}, platform })).toEqual({ enabled: false });
    }
  });

  it("treats off as the explicit way to decline a backend the host has", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(resolveDesktopNotice({ env: { SQUID_NOTIFY: "off" }, platform })).toEqual({
        enabled: false,
      });
    }
  });

  it("uses the host mechanism on the exact value", () => {
    for (const platform of ["linux", "win32"] as const) {
      const resolved = resolveDesktopNotice({ env: { SQUID_NOTIFY: "desktop" }, platform });
      if ("configError" in resolved) throw new Error(resolved.configError);
      // The disabled arm carries no factory and `configError` narrowing does not
      // exclude it: an explicit value asked to be heard, so assert it can be.
      if (!resolved.enabled) throw new Error(`expected desktop notices to be enabled on ${platform}`);
      expect(resolved.noticeKind).toBe("desktop");
      expect(typeof resolved.notifierFactory).toBe("function");
    }
  });

  it("refuses any other spelling", () => {
    for (const value of ["on", "true", "toast", "DESKTOP", "desktop "]) {
      const resolved = resolveDesktopNotice({ env: { SQUID_NOTIFY: value }, platform: "linux" });
      expect("configError" in resolved && resolved.configError).toContain(
        'must be unset, "off", or exactly "desktop"',
      );
    }
  });

  /**
   * A host without a backend refuses an *asked-for* backend and says what is
   * missing, rather than resolving to `off`.
   *
   * This is the other half of the split the default introduced: unset is the
   * quiet arm asserted above, and `desktop` spelled out is a request. The
   * refusal names the prerequisite, which is the difference between a gap
   * someone can close and one nobody can see — a run that asked to be
   * interrupted and silently was not looks exactly like a run whose daemon is
   * asleep.
   */
  it("names what each host without a backend is missing when asked for one", () => {
    const macos = resolveDesktopNotice({ env: { SQUID_NOTIFY: "desktop" }, platform: "darwin" });
    expect("configError" in macos && macos.configError).toContain("bundle");

    // Not an enumerated platform: still refused, and still naming the host, so
    // the message is useful on a BSD nobody thought about.
    const other = resolveDesktopNotice({ env: { SQUID_NOTIFY: "desktop" }, platform: "freebsd" });
    expect("configError" in other && other.configError).toContain("freebsd");
  });

  /**
   * Both backends come from one pairing: the platform the resolver named is the
   * platform the factory demands. The Linux test asserts the same thing —
   * each backend throws when built off its host, so a resolver that decided
   * with the argument but built with `process.platform` would only agree with
   * itself on its own host. Asserting the factory is *callable* here is what
   * catches that, and it is why this suite can run anywhere.
   */
  it("builds a notifier the caller can construct on the platform it named", () => {
    for (const platform of ["linux", "win32"] as const) {
      const resolved = resolveDesktopNotice({ env: { SQUID_NOTIFY: "desktop" }, platform });
      if ("configError" in resolved || !resolved.enabled) {
        throw new Error(`expected desktop notices to be enabled on ${platform}`);
      }
      const notifier = resolved.notifierFactory({ onDiagnostic: () => undefined });
      expect(typeof notifier.notify).toBe("function");
      void notifier.close();
    }
  });
});
