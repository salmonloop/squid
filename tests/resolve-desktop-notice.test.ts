import { describe, expect, it } from "bun:test";
import { resolveDesktopNotice } from "../src/resolve-desktop-notice.js";

/**
 * Speaking up defaults to off, and for its own reason. The browser reader is off
 * by default because observing costs privacy; this is off by default because
 * interrupting costs attention, and a run earns that by asking.
 */
describe("resolveDesktopNotice", () => {
  it("is quiet when the variable is unset", () => {
    expect(resolveDesktopNotice({ env: {}, platform: "linux" })).toEqual({ enabled: false });
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
        'must be unset (quiet) or exactly "desktop"',
      );
    }
  });

  /**
   * A host without a backend refuses and says what is missing, rather than
   * resolving to `off`.
   *
   * This is the whole reason the platform arm exists. A run that asked to be
   * interrupted and silently was not looks exactly like a run on a desktop whose
   * daemon is asleep, and the person has no way to tell which they have. The
   * refusal names the prerequisite instead, which is the difference between a
   * gap someone can close and one nobody can see.
   *
   * Windows is a backend now, so it is asserted in the pairing test below; the
   * refusals here are the hosts that still lack one.
   */
  it("names what each host without a backend is missing", () => {
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
