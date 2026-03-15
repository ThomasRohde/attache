import { platform } from 'os';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

if (platform() !== 'win32') {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const exeSrc = join(__dirname, '..', 'shell', 'dist-win', 'AttacheShell.exe');

if (!existsSync(exeSrc)) {
  // Pre-built exe not present — dev environment or non-Windows CI, skip silently
  process.exit(0);
}

const localAppData =
  process.env.LOCALAPPDATA ||
  join(process.env.USERPROFILE || '', 'AppData', 'Local');

const installDir = join(localAppData, 'Programs', 'attache-shell');
const exeDest = join(installDir, 'AttacheShell.exe');

mkdirSync(installDir, { recursive: true });
copyFileSync(exeSrc, exeDest);

console.log(`✅ Attache Shell installed to: ${exeDest}`);
console.log(`   Launch it to add Attache to your Windows system tray.`);
