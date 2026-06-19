// Smoke test for the integration-test harness itself.
//
// Proves the end-to-end machinery works: the disposable DB was created,
// migrated and seeded by globalSetup; the app boots; a minted admin token
// authenticates; auth gating returns 401 without a token; and a list route
// returns the seeded org's rows. Page-build agents model their own
// `*.itest.ts` specs on this shape.
import { describe, expect, it } from "vitest";
import {
  authedInject,
  expectJson,
  expectUnauthorized,
  getApp,
  tokenFor,
} from "../test/harness.js";

describe("integration harness smoke", () => {
  it("boots the app and serves the unauthenticated health route", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = expectJson<{ status: string }>(res);
    expect(body.status).toBe("ok");
  });

  it("rejects a protected route with no token (401)", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "GET", url: "/api/rubrics" });
    expectUnauthorized(res);
  });

  it("accepts a minted admin token on a protected route (200)", async () => {
    const res = await authedInject("admin@recruitassist.local", {
      method: "GET",
      url: "/api/rubrics",
    });
    expectJson(res, 200);
  });

  it("returns the seeded org's rubric rows for the admin", async () => {
    const res = await authedInject("admin@recruitassist.local", {
      method: "GET",
      url: "/api/rubrics",
    });
    const body = expectJson<{ rubrics: Array<{ id: string; name: string }> }>(res);
    expect(Array.isArray(body.rubrics)).toBe(true);
    // The seed inserts three default rubrics into the demo org.
    expect(body.rubrics.length).toBeGreaterThanOrEqual(3);
    const names = body.rubrics.map((r) => r.name);
    expect(names).toContain("General Screening");
  });

  it("mints distinct tokens for different seeded roles", async () => {
    const adminToken = await tokenFor("admin@recruitassist.local");
    const recruiterToken = await tokenFor("recruiter1@recruitassist.local");
    const qaToken = await tokenFor("qa1@recruitassist.local");
    expect(adminToken).toBeTruthy();
    expect(recruiterToken).toBeTruthy();
    expect(qaToken).toBeTruthy();
    expect(adminToken).not.toBe(recruiterToken);
    expect(recruiterToken).not.toBe(qaToken);
  });
});
