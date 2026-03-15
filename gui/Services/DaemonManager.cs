using System.Diagnostics;
using System.Windows.Forms;

namespace AttacheGui.Services;

public class DaemonManager
{
    private Process? _process;

    public bool IsRunning => _process is { HasExited: false };

    public void Start()
    {
        if (IsRunning) return;

        if (!TryResolveCommand(out var fileName, out var arguments))
            return;

        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };

        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var npmBin = Path.Combine(appData, "npm");
        if (!path.Contains(npmBin, StringComparison.OrdinalIgnoreCase))
            psi.EnvironmentVariables["PATH"] = $"{npmBin};{path}";

        try
        {
            _process = Process.Start(psi);
            // Drain streams asynchronously to prevent buffer deadlocks
            _process?.BeginOutputReadLine();
            _process?.BeginErrorReadLine();
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
        catch { }
        finally { _process = null; }
    }

    private static bool TryResolveCommand(out string fileName, out string arguments)
    {
        fileName = "";
        arguments = "";

        // Check known paths first to avoid spawning where.exe (which can flash a console)
        var nodePath = FindNodeExe() ?? TryWhich("node");

        // 1. Try walking up from the exe directory (dev / co-located layout — always freshest)
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

        // 2. Fall back to the globally-installed npm package
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

        MessageBox.Show(
            "Could not locate the 'attache' command.\n\n" +
            "Install Attache globally:\n\n" +
            "    npm install -g attache\n\n" +
            "Then restart this app.",
            "Attache — Command Not Found",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
        return false;
    }

    private static string? TryWhich(string name)
    {
        try
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var npmBin = Path.Combine(appData, "npm");
            var currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
            var augmentedPath = currentPath.Contains(npmBin, StringComparison.OrdinalIgnoreCase)
                ? currentPath
                : $"{npmBin};{currentPath}";

            var psi = new ProcessStartInfo("where.exe", name)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            psi.EnvironmentVariables["PATH"] = augmentedPath;

            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadLine()?.Trim();
            p.WaitForExit(2000);
            return (p.ExitCode == 0 && !string.IsNullOrEmpty(output)) ? output : null;
        }
        catch { return null; }
    }

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
