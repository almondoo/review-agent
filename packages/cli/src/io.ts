// Captures stdout/stderr/exit channels behind a single object so the CLI is
// testable without monkeypatching globals. The bin (`cli.ts`) wires this to
// process.stdout / process.stderr / process.exit; tests pass a recording fake.
export type ProgramIo = {
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly exit: (code: number) => void;
};

export function defaultIo(): ProgramIo {
  return {
    stdout: (chunk) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk) => {
      process.stderr.write(chunk);
    },
    exit: (code) => {
      process.exit(code);
    },
  };
}
