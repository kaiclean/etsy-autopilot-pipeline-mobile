import { expect, test, type Page } from "@playwright/test";

const sections = [
  ["Pipeline", "Pipeline"],
  ["Approval queue", "Approval queue"],
  ["Products", "Products"],
  ["Orders", "Orders"],
  ["Analytics", "Analytics"],
  ["Connections", "Connections"],
  ["Settings", "Settings"],
] as const;

async function unlock(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("autopilot");
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Kai");
}

test("sends anonymous visitors to sign in", async ({ page }) => {
  await page.goto("/pipeline");
  await expect(page).toHaveURL(/\/login\?next=%2Fpipeline/);
  await expect(page.getByRole("heading", { name: "Etsy Autopilot" })).toBeVisible();
  await expect(page.getByText("the password is")).toBeVisible();
  await expect(page.getByText("autopilot", { exact: true })).toBeVisible();
});

test("rejects the wrong password", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("unlocks the command center in dry-run", async ({ page }) => {
  await unlock(page);
  await expect(page.getByRole("link", { name: "DRY-RUN" }).first()).toBeVisible();
  await expect(page.getByText("Demo data").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /listings to review/ })).toBeVisible();
});

test("opens each primary section from the sidebar", async ({ page }) => {
  await unlock(page);
  const nav = page.locator("aside nav");
  for (const [link, heading] of sections) {
    await nav.getByRole("link", { name: new RegExp(link) }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
});

test("uses the mobile tab bar to open More and Products", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await unlock(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
  await page.getByRole("link", { name: "Products & listings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Products" })).toBeVisible();
});
