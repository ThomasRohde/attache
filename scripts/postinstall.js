import { platform } from 'os';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

if (platform() !== 'win32') {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const localAppData =
  process.env.LOCALAPPDATA ||
  join(process.env.USERPROFILE || '', 'AppData', 'Local');

// Install AttacheGui (Blazor desktop app)
const guiSrc = join(__dirname, '..', 'gui', 'dist-win', 'AttacheGui.exe');
if (existsSync(guiSrc)) {
  const guiDir = join(localAppData, 'Programs', 'attache-gui');
  const guiDest = join(guiDir, 'AttacheGui.exe');
  mkdirSync(guiDir, { recursive: true });
  copyFileSync(guiSrc, guiDest);
  console.log(`Attache GUI installed to: ${guiDest}`);
  console.log(`  Launch it for the full Attache desktop experience.`);
}
