import { Schema } from "effect";

export const DeviceInfo = Schema.Struct({
  platform: Schema.Literals(["android", "ios", "web", "electron", "electrobun"]),
  deviceId: Schema.String,
  name: Schema.String,
  isEmulator: Schema.Boolean,
  screenWidth: Schema.Number,
  screenHeight: Schema.Number,
  driverType: Schema.Literals([
    "playwright",
    "uiautomator2",
    "wda",
    "appium",
    "electron",
    "electrobun",
  ]),
});
export type DeviceInfo = typeof DeviceInfo.Type;
