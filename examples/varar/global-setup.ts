import { createServer } from "node:http";
import { readFileSync } from "node:fs";
export default function () {
  const server = createServer((_req, res) => res.end(readFileSync("app/index.html"))).listen(4173);
  return () => server.close();
}
