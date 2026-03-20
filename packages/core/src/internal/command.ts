import { spawn } from "node:child_process";
import type { P4CommandOptions, P4CommandResult } from "../public/types.js";

export async function runCommand(
  command: string,
  args: string[],
  options: P4CommandOptions = {}
): Promise<P4CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (exitCode) => {
      resolve({
        command,
        args,
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
