import { render } from "ink";
import { pathToFileURL } from "url";
import { InkShellApp } from "./app.js";

export function runInkTui(): void {
  render(<InkShellApp />, {
    exitOnCtrlC: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInkTui();
}
