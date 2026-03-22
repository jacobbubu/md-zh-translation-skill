export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class InputError extends CliError {
  constructor(message: string) {
    super(message, 2);
  }
}

export class CodexExecutionError extends CliError {
  constructor(message: string) {
    super(message, 3);
  }
}

export class HardGateError extends CliError {
  constructor(message: string) {
    super(message, 4);
  }
}

export class FormattingError extends CliError {
  constructor(message: string) {
    super(message, 5);
  }
}
