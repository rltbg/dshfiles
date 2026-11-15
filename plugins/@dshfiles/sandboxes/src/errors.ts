import { Schema } from 'effect'

/** No sandbox with that id. */
export class SandboxNotFound extends Schema.TaggedError<SandboxNotFound>()(
  'SandboxNotFound',
  { id: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-not-found' },
) {
  override get message(): string {
    return `There is no sandbox ${this.id}; list the sandboxes (sandbox_list) and retry with one of their ids.`
  }
}

/** The request does not fit the sandbox's current state, such as starting one that is already running. */
export class SandboxStateConflict extends Schema.TaggedError<SandboxStateConflict>()(
  'SandboxStateConflict',
  { id: Schema.String, state: Schema.String, wanted: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-state-conflict' },
) {
  override get message(): string {
    return `Sandbox ${this.id} is ${this.state}, so it cannot ${this.wanted}; inspect it (sandbox_inspect) for what it can do now.`
  }
}

/** No provider can run a sandbox on this machine. */
export class SandboxProviderUnavailable extends Schema.TaggedError<SandboxProviderUnavailable>()(
  'SandboxProviderUnavailable',
  { provider: Schema.String, reason: Schema.String, fix: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-provider-unavailable' },
) {
  override get message(): string {
    return `The ${this.provider} sandbox provider is not available: ${this.reason}. ${this.fix}`
  }
}

/** A step of a sandbox's lifecycle failed; the record keeps the step and the recovery. */
export class SandboxStepFailed extends Schema.TaggedError<SandboxStepFailed>()(
  'SandboxStepFailed',
  { id: Schema.String, step: Schema.String, detail: Schema.String, recovery: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-step-failed' },
) {
  override get message(): string {
    return `Sandbox ${this.id} could not ${this.step}: ${this.detail}. ${this.recovery}`
  }
}

/** A destructive request was made without its explicit opt-in. */
export class SandboxConfirmationRequired extends Schema.TaggedError<SandboxConfirmationRequired>()(
  'SandboxConfirmationRequired',
  { id: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-confirmation-required' },
) {
  override get message(): string {
    return `Destroying sandbox ${this.id} ${this.reason}; ask the user, then call again with confirmDestroy: true.`
  }
}

/** The project is not a git repository with a commit, so it cannot be copied into a sandbox. */
export class SandboxProjectUnsupported extends Schema.TaggedError<SandboxProjectUnsupported>()(
  'SandboxProjectUnsupported',
  { path: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { dshxWireCode: 'sandbox-project-unsupported' },
) {
  override get message(): string {
    return `${this.path} cannot be copied into a sandbox: ${this.reason}. Commit the project in git first, or run the thread without a sandbox.`
  }
}

export type SandboxError =
  | SandboxNotFound
  | SandboxStateConflict
  | SandboxProviderUnavailable
  | SandboxStepFailed
  | SandboxConfirmationRequired
  | SandboxProjectUnsupported
