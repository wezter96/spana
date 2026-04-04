// prov — TypeScript-native E2E testing for React Native + Web

// User-facing API
export { flow, type FlowConfig, type FlowContext, type FlowFn, type FlowDefinition } from "./api/flow.js";
export { type PromiseApp } from "./api/app.js";
export { type PromiseExpectation } from "./api/expect.js";

// Schemas
export { type Selector, type Platform } from "./schemas/selector.js";
export { defineConfig, type ProvConfig, type AppConfig, type ArtifactConfig } from "./schemas/config.js";
export { type Element } from "./schemas/element.js";
export { type DeviceInfo } from "./schemas/device.js";
