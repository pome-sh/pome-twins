// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:net";

// NOTE: allocate-then-close hands back a port that is free at close time; a
// caller that rebinds it races any other process that grabs it in the gap.
// Pre-existing and acceptable for local dev twins (loopback, short-lived).
export async function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not allocate a local port")));
      }
    });
  });
}
