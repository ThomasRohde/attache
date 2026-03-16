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

        // Check known paths first, then scan PATH — never spawn where.exe
        var nodePath = FindNodeExe() ?? TryFindInPath("node.exe");

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

    /// <summary>
    /// Scans PATH entries directly for the given executable — no subprocess spawned.
    /// Includes the npm global bin dir in the search even if it's not already in PATH.
    /// </summary>
    private static string? TryFindInPath(string executable)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var npmBin = Path.Combine(appData, "npm");
        var currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";

        // Prepend the npm bin dir so npm-shim node is found if system node isn't
        var searchPath = currentPath.Contains(npmBin, StringComparison.OrdinalIgnoreCase)
            ? currentPath
            : $"{npmBin};{currentPath}";

        foreach (var segment in searchPath.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var dir = segment.Trim().Trim('"');
            if (string.IsNullOrEmpty(dir)) continue;
            var candidate = Path.Combine(dir, executable);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private static string? FindNodeExe()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        var candidates = new[]
        {
            // Standard installer
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            // NVM for Windows (symlink-style current)
            Path.Combine(appData, @"nvm\current\node.exe"),
            // Volta shim
            Path.Combine(localAppData, @"Volta\bin\node.exe"),
            // Scoop (nodejs and nodejs-lts)
            Path.Combine(userProfile, @"scoop\apps\nodejs\current\node.exe"),
            Path.Combine(userProfile, @"scoop\apps\nodejs-lts\current\node.exe"),
            Path.Combine(userProfile, @"scoop\shims\node.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }
}
