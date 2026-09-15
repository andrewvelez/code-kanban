module.exports = {
  testDir: './test', testMatch: '**/*.spec.js', workers: 1,
  use: { viewport: { width: 1600, height: 960 }, headless: true,
    launchOptions: process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}
  },
  reporter: 'list'
};
