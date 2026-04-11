import { Schema } from "effect";

// Assertion errors

export class ElementNotFoundError extends Schema.TaggedError<ElementNotFoundError>()(
  "ElementNotFoundError",
  {
    message: Schema.String,
    selector: Schema.Unknown,
    timeoutMs: Schema.optional(Schema.Number),
  },
) {}

export class TextMismatchError extends Schema.TaggedError<TextMismatchError>()(
  "TextMismatchError",
  {
    message: Schema.String,
    expected: Schema.String,
    actual: Schema.optional(Schema.String),
    selector: Schema.Unknown,
  },
) {}

// Timeout errors

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("TimeoutError", {
  message: Schema.String,
  operation: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class WaitTimeoutError extends Schema.TaggedError<WaitTimeoutError>()("WaitTimeoutError", {
  message: Schema.String,
  selector: Schema.Unknown,
  timeoutMs: Schema.Number,
}) {}

// Connection errors

export class DriverError extends Schema.TaggedError<DriverError>()("DriverError", {
  message: Schema.String,
  command: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
}) {}

export class DeviceDisconnectedError extends Schema.TaggedError<DeviceDisconnectedError>()(
  "DeviceDisconnectedError",
  {
    message: Schema.String,
    deviceId: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
  },
) {}

// App errors

export class AppCrashedError extends Schema.TaggedError<AppCrashedError>()("AppCrashedError", {
  message: Schema.String,
  appId: Schema.optional(Schema.String),
  platform: Schema.optional(Schema.String),
}) {}

export class AppNotInstalledError extends Schema.TaggedError<AppNotInstalledError>()(
  "AppNotInstalledError",
  {
    message: Schema.String,
    appId: Schema.String,
    platform: Schema.optional(Schema.String),
  },
) {}

// Config errors

export class FlowSyntaxError extends Schema.TaggedError<FlowSyntaxError>()("FlowSyntaxError", {
  message: Schema.String,
  filePath: Schema.String,
}) {}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  {
    message: Schema.String,
    platform: Schema.optional(Schema.String),
    deviceId: Schema.optional(Schema.String),
  },
) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  filePath: Schema.optional(Schema.String),
}) {}

// Union type of all error types

export type ProvError =
  | ElementNotFoundError
  | TextMismatchError
  | TimeoutError
  | WaitTimeoutError
  | DriverError
  | DeviceDisconnectedError
  | AppCrashedError
  | AppNotInstalledError
  | FlowSyntaxError
  | DeviceNotFoundError
  | ConfigError;
