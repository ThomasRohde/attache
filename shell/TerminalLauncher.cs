using System.Diagnostics;
using System.Windows.Forms;

namespace AttacheShell;

public static class TerminalLauncher
{
    /// <summary>
    /// Opens a new terminal window running the given attache command.
    /// Resolves the command to its full npm .cmd shim path so no PATH
    /// augmentation is needed inside the spawned terminal.
    /// Tries Windows Terminal, then a plain cmd window.
    /// </summary>
    public static void Open(string command)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var npmBin = Path.Combine(appData, "npm");
        var windowsApps = Path.Combine(localAppData, "Microsoft", "WindowsApps");

        // Resolve "attache tui" → '"C:\...\npm\attache.cmd" tui'
        var resolved = ResolveNpmCommand(command, npmBin);

        // Resolve wt.exe — Store AppExecutionAlias that CreateProcess can't always find
        var wtPath = FindInDir("wt.exe", windowsApps)
                  ?? FindOnPath("wt.exe");

        var attempts = new (string exe, string args)[]
        {
            (wtPath ?? "wt.exe", $"-- cmd /k {resolved}"),
            ("cmd.exe",          $"/k {resolved}"),
        };

        foreach (var (exe, args) in attempts)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = args,
                    UseShellExecute = false,
                });
                return;
            }
            catch { /* try next */ }
        }

        MessageBox.Show(
            $"Could not open a terminal to run:\n\n  {command}\n\nPlease run it manually.",
            "Attache — Terminal Error",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
    }

    /// <summary>
    /// Resolves a command like "attache tui" to its full .cmd shim path,
    /// e.g. '"C:\Users\x\AppData\Roaming\npm\attache.cmd" tui'.
    /// Falls back to the original command if the shim is not found.
    /// </summary>
    private static string ResolveNpmCommand(string command, string npmBin)
    {
        var parts = command.Split(' ', 2);
        var cmdShim = Path.Combine(npmBin, parts[0] + ".cmd");
        if (!File.Exists(cmdShim))
            return command;

        var args = parts.Length > 1 ? " " + parts[1] : "";
        return $"\"{cmdShim}\"{args}";
    }

    private static string? FindInDir(string name, string dir)
    {
        var candidate = Path.Combine(dir, name);
        return File.Exists(candidate) ? candidate : null;
    }

    private static string? FindOnPath(string name)
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), name);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }
}
