import { platform } from 'os';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

if (platform() !== 'win32') {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const localAppData =
  process.env.LOCALAPPDATA ||
  join(process.env.USERPROFILE || '', 'AppData', 'Local');

// Patch @openai/codex-sdk to hide console windows on Windows.
// The SDK spawns codex CLI processes without windowsHide, causing flashing
// terminal windows. ESM named imports capture the original spawn reference,
// so monkey-patching child_process.spawn at runtime doesn't work.
const codexSdkPath = join(__dirname, '..', 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');
if (existsSync(codexSdkPath)) {
  try {
    let code = readFileSync(codexSdkPath, 'utf-8');
    const needle = 'spawn(this.executablePath, commandArgs, {\n      env,\n      signal: args.signal\n    })';
    const replacement = 'spawn(this.executablePath, commandArgs, {\n      env,\n      signal: args.signal,\n      windowsHide: true\n    })';
    if (code.includes(needle)) {
      code = code.replace(needle, replacement);
      writeFileSync(codexSdkPath, code);
      console.log('Patched @openai/codex-sdk: added windowsHide to spawn()');
    } else if (code.includes('windowsHide: true')) {
      console.log('@openai/codex-sdk already patched (windowsHide present)');
    } else {
      console.log('Warning: Could not locate spawn() call in @openai/codex-sdk — SDK may have changed');
    }
  } catch (err) {
    console.log(`Warning: Failed to patch @openai/codex-sdk: ${err.message}`);
  }
}

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
