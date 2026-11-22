// Loads the repo-root .env before the tests. In CI the file is copied from .env.example.
// Node's built-in loader (process.loadEnvFile) avoids a dotenv dependency.
try {
  process.loadEnvFile('../../.env');
} catch {
  // No .env file: rely on variables already set in the environment.
}
