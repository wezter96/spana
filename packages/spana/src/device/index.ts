export {
  findADB,
  listAndroidDevices,
  firstAndroidDevice,
  adbForward,
  adbShell,
  adbInstall,
  type AndroidDevice,
} from "./android.js";
export {
  listIOSSimulators,
  listBootedSimulators,
  firstIOSSimulator,
  firstIOSSimulatorWithApp,
  hasAppInstalledOnSimulator,
  bootSimulator,
  installOnSimulator,
  launchOnSimulator,
  terminateOnSimulator,
  type IOSSimulator,
  type IOSDevice,
} from "./ios.js";
export { discoverDevices, firstDeviceForPlatform, type DiscoveredDevice } from "./discover.js";
