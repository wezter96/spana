import { steps } from "@varar/varar";
import { connect, type Session } from "spana-test/agent";
import { afterAll } from "vitest";

let session: Session | undefined;
afterAll(() => session?.disconnect());

const { stimulus, sensor } = steps(async () => {
  session ??= await connect({
    platform: "web",
    baseUrl: process.env.APP_URL ?? "http://localhost:4173",
  });
  await session.launch();
  return { app: session };
});

stimulus("the shopper adds {int} items to the cart", async ({ app }, count) => {
  for (let i = 0; i < count; i++) await app.tap({ testID: "add-to-cart" });
});

// Read a value by testID. selectors() works on web, iOS, Android and desktop.
async function textOf(app: Session, testID: string) {
  return (await app.selectors()).find((el) => el.id === testID)?.text;
}

sensor("the cart shows {int} items", async ({ app }) => Number(await textOf(app, "cart-count")));
