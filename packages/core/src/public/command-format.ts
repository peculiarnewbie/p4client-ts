/**
 * Format a command argument vector for logs and error messages, redacting
 * credential-like flags and assignment forms.
 */
export function formatCommandArgs(args: readonly string[]): string {
  return redactCommandArgs(args).join(" ");
}

/**
 * Return a copy of argv with credential-like values replaced by `***`.
 */
export function redactCommandArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "-P" || arg === "--password") {
      redacted.push(arg, "***");
      if (index + 1 < args.length) {
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("-P") && arg.length > 2) {
      redacted.push("-P***");
      continue;
    }

    if (/^P4PASSWD=/i.test(arg)) {
      redacted.push("P4PASSWD=***");
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}
