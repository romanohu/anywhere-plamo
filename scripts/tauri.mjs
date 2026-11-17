import { fileURLToPath } from 'node:url';
import { run, logError } from '@tauri-apps/cli';

process.env.TAURI_APP_PATH = fileURLToPath(new URL('../gui/native/', import.meta.url));
process.env.TAURI_FRONTEND_PATH = fileURLToPath(new URL('../', import.meta.url));

try {
  await run(process.argv.slice(2), 'npm run tauri');
} catch (error) {
  logError(error.message);
  process.exitCode = 1;
}
