using System.Diagnostics;
using System.Windows.Forms;

namespace AttacheShell;

public class DaemonManager
{
    private Process? _process;

    public bool IsRunning => _process is { HasExited: false };

    public void Start()
    {
        if (IsRunning) return;

        if (!TryResolveCommand(out var fileName, out var arguments))
            return; // TryResolveCommand shows error dialog on failure

        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        // Ensure npm global bin dirs are on PATH for the child process
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var npmBin = Path.Combine(appData, "npm");
        if (!path.Contains(npmBin, StringComparison.OrdinalIgnoreCase))
            psi.EnvironmentVariables["PATH"] = $"{npmBin};{path}";

        try
        {
            _process = Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Failed to start the Attache daemon:\n\n{ex.Message}",
                "Attache — Start Failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    public void Stop()
    {
        if (_process is null || _process.HasExited)
        {
            _process = null;
            return;
        }

        try
        {
            _process.Kill(entireProcessTree: true);
            _process.WaitForExit(3000);
        }
        catch { /* already gone */ }
        finally { _process = null; }
    }

    /// <summary>
    /// Resolves how to invoke the attache daemon.
    /// Priority:
    ///   1. `attache` on PATH (global npm install, properly configured PATH)
    ///   2. `node %APPDATA%\npm\node_modules\attache\dist\cli.js` (global npm install, PATH not set)
    ///   3. `node` + dist/cli.js found by walking up from the exe (dev / from-source mode)
    /// </summary>
    private static bool TryResolveCommand(out string fileName, out string arguments)
    {
        fileName = "cmd.exe";
        arguments = "/c attache start";

        // Strategy 1: attache.cmd found via where.exe (PATH + npm bin augmentation)
        var wherePath = TryWhich("attache");
        if (wherePath is not null)
        {
            fileName = "cmd.exe";
            arguments = $"/c \"{wherePath}\" start";
            return true;
        }

        var nodePath = TryWhich("node") ?? FindNodeExe();

        // Strategy 2: node + global npm module path
        if (nodePath is not null)
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var cliJs = Path.Combine(appData, "npm", "node_modules", "attache", "dist", "cli.js");
            if (File.Exists(cliJs))
            {
                fileName = nodePath;
                arguments = $"\"{cliJs}\" start";
                return true;
            }
        }

        // Strategy 3: walk up from exe location to find dist/cli.js (dev / from-source)
        if (nodePath is not null)
        {
            var dir = AppContext.BaseDirectory;
            for (int i = 0; i < 8; i++)
            {
                var candidate = Path.Combine(dir, "dist", "cli.js");
                if (File.Exists(candidate))
                {
                    fileName = nodePath;
                    arguments = $"\"{candidate}\" start";
                    return true;
                }
                var parent = Directory.GetParent(dir)?.FullName;
                if (parent is null) break;
                dir = parent;
            }
        }

        // Nothing worked — warn the user
        MessageBox.Show(
            "Could not locate the 'attache' command.\n\n" +
            "Install Attache globally:\n\n" +
            "    npm install -g attache\n\n" +
            "Then restart this tray app.",
            "Attache — Command Not Found",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
        return false;
    }

    /// <summary>Runs where.exe to find the full path of an executable.</summary>
    private static string? TryWhich(string name)
    {
        try
        {
            // Augment PATH with npm global bin so where.exe can find npm-installed commands
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var npmBin = Path.Combine(appData, "npm");
            var currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            var augmentedPath = currentPath.Contains(npmBin, StringComparison.OrdinalIgnoreCase)
                ? currentPath
                : $"{npmBin};{currentPath}";

            var psi = new ProcessStartInfo("where.exe", name)
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.EnvironmentVariables["PATH"] = augmentedPath;

            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadLine()?.Trim();
            p.WaitForExit(2000);
            return (p.ExitCode == 0 && !string.IsNullOrEmpty(output)) ? output : null;
        }
        catch { return null; }
    }

    /// <summary>Looks for node.exe in well-known install locations.</summary>
    private static string? FindNodeExe()
    {
        var candidates = new[]
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"nvm\current\node.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }
}
