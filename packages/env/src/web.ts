import { createEnv } from "@t3-oss/env-core";

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {},
  emptyStringAsUndefined: true,
  runtimeEnv: {},
});
