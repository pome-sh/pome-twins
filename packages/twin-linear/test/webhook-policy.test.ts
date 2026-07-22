// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isBlockedIp,
  privateWebhooksAllowed,
  webhookDestinationBlocked,
} from "../src/webhook-policy.js";

describe("webhook SSRF policy", () => {
  it("blocks loopback, private, link-local, and reserved IP literals", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
      "255.255.255.255",
      "224.0.0.1", // multicast
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IP literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.0.1", "2606:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("blocks an IP-literal metadata destination without any DNS", async () => {
    expect(await webhookDestinationBlocked("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(await webhookDestinationBlocked("http://[::1]:9000/hook")).toBe(true);
  });

  it("blocks a public hostname that resolves to an internal address", async () => {
    const resolve = async () => [{ address: "10.1.2.3" }];
    expect(await webhookDestinationBlocked("https://rebind.example.com/hook", { resolve })).toBe(true);
  });

  it("allows a hostname that resolves to public addresses", async () => {
    const resolve = async () => [{ address: "93.184.216.34" }];
    expect(await webhookDestinationBlocked("https://example.com/hook", { resolve })).toBe(false);
  });

  it("does not block when private delivery is explicitly trusted", async () => {
    expect(
      await webhookDestinationBlocked("http://169.254.169.254/", { allowPrivate: true })
    ).toBe(false);
  });

  it("refuses unparseable URLs", async () => {
    expect(await webhookDestinationBlocked("http://")).toBe(true);
  });

  it("reads the trust flag from the environment", () => {
    expect(privateWebhooksAllowed({ LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS: "1" })).toBe(true);
    expect(privateWebhooksAllowed({ LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS: "true" })).toBe(true);
    expect(privateWebhooksAllowed({})).toBe(false);
  });
});
