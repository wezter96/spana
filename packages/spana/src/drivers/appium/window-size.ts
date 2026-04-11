import type { AppiumClient } from "./client.js";

interface WindowSize {
  width: number;
  height: number;
}

interface WindowRect extends WindowSize {
  x: number;
  y: number;
}

export async function getAppiumWindowSize(client: AppiumClient): Promise<WindowSize> {
  try {
    return await client.request<WindowSize>("GET", client.sessionPath("/window/size"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("/window/size") || !message.includes("-> 404:")) {
      throw error;
    }

    const rect = await client.request<WindowRect>("GET", client.sessionPath("/window/rect"));
    return { width: rect.width, height: rect.height };
  }
}
