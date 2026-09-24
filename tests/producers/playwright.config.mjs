export default {
  testDir: ".",
  testMatch: "playwright.cases.mjs",
  workers: 1,
  retries: 0,
  reporter: "junit",
  outputDir: process.env.TEST_LAB_PRODUCER_OUTPUT,
};
