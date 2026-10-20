import { createLogger } from "better-auth";
import type { Logger } from "better-auth";
import { Option, Predicate, Schema } from "effect";

const ErrorDetails = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

const LogValue = Schema.Union([Schema.String, ErrorDetails]);

const redactEmails = (value: string) =>
  value.includes("@") ? "[redacted email]" : value;

const logArgument = (value: typeof LogValue.Type) => {
  if (Predicate.isString(value)) {
    return redactEmails(value);
  }

  const details: Record<string, string>[] = [];
  const seen = new WeakSet<object>();
  let current: unknown = value;

  while (Predicate.isObject(current) && !seen.has(current)) {
    seen.add(current);

    const decoded = Schema.decodeOption(ErrorDetails)(current);

    if (Option.isNone(decoded)) {
      break;
    }

    const { cause, ...fields } = decoded.value;

    details.push(
      Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [key, redactEmails(field)])
      )
    );
    current = cause;
  }

  return details;
};

const output = createLogger({ disableColors: true });

export const authLogger: Logger = {
  log: (level, message, ...args: unknown[]) => {
    const text = Predicate.isString(message)
      ? redactEmails(message)
      : "authentication event";

    const values = Predicate.isString(message) ? args : [message, ...args];

    output[level](
      text,
      ...values.map((value) =>
        Option.match(Schema.decodeUnknownOption(LogValue)(value), {
          onNone: () => [],
          onSome: logArgument,
        })
      )
    );
  },
};
