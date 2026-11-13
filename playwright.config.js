const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'browser.spec.js', workers: 1, timeout: 120000, reporter: [['list'], ['html', { open: 'never' }]], use: { headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } });
