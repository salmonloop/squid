/**
 * Where Windows PowerShell is, for every part of this repository that spawns it.
 *
 * **`powershell.exe` is not reliably on `PATH`.** A POSIX-flavoured parent — Git
 * Bash, MSYS, a shell inside an editor — hands the child a `PATH` that often
 * omits the System32 subdirectory the interpreter lives in, and the child then
 * fails to start a program that is definitely installed. `%SystemRoot%` is the
 * variable Windows itself guarantees, and the location under it has been fixed
 * since PowerShell 1.0.
 *
 * **It must be Windows PowerShell rather than `pwsh`,** and for two separate
 * reasons that both matter here. The UI Automation client the screen reader
 * loads is a .NET Framework assembly, which `pwsh` does not load; and
 * `System.Windows.Forms`, which the desktop notice needs, is the same kind of
 * assembly and additionally wants an STA thread, which `powershell.exe` gives by
 * default and `pwsh` does not.
 *
 * This lives in its own file because three callers need the same answer — the
 * screen reader and the visual smoke host spawn it today, and the Windows
 * desktop notice backend, which needs `System.Windows.Forms`, is the third —
 * and the failure mode of disagreeing is a program that cannot be found on a
 * machine where it is present. One measured fact, one owner.
 *
 * Absolute rather than relative, which also means the interpreter cannot be
 * shadowed by something earlier on `PATH` calling itself `powershell.exe`: for a
 * process that loads .NET assemblies and touches the desktop, that is worth
 * being deliberate about.
 */

/**
 * The fallback when the environment says nothing.
 *
 * A Windows host with no `SystemRoot` is a broken environment rather than an
 * unusual one, and guessing the overwhelmingly common location gives the caller
 * a chance of working instead of a certainty of not.
 */
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";

/**
 * Built with literal separators rather than `node:path`, on purpose.
 *
 * `join` answers in the *host's* dialect, so this expression would produce
 * forward slashes when a test runs on Linux — and the whole value of asserting
 * it there is that the string a Windows host will receive is the string the
 * suite checked. The path is Windows-shaped everywhere because the program it
 * names only exists on Windows.
 */
export function windowsPowerShellPath(
  env: Record<string, string | undefined> = process.env,
): string {
  // Both spellings, because a Windows environment block is case-insensitive
  // while the object modelling it here is not: a caller that built its own env
  // from a config file may well have written `SYSTEMROOT`.
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? DEFAULT_SYSTEM_ROOT;
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}
