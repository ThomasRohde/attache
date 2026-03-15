using System.Diagnostics;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AttacheShell;

public class TrayApplicationContext : ApplicationContext
{
    private readonly NotifyIcon _trayIcon;
    private readonly DaemonManager _daemon = new();
    private readonly ApiClient _api = new();
    private readonly System.Windows.Forms.Timer _statusTimer = new() { Interval = 30_000 };
    private ToolStripMenuItem _startItem = null!;
    private ToolStripMenuItem _stopItem = null!;
    private ToolStripMenuItem _autoStartItem = null!;
    private QuickInputForm? _quickInputForm;

    public TrayApplicationContext()
    {
        _trayIcon = new NotifyIcon
        {
            Icon = Icons.Grey,
            Text = "Attache — starting…",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };

        _trayIcon.DoubleClick += (_, _) => OpenQuickInput();

        _statusTimer.Tick += async (_, _) => await RefreshStatusAsync();
        _statusTimer.Start();

        // Auto-start daemon immediately on launch
        _daemon.Start();
        SetIcon(DaemonState.Starting);

        // First status check after a short warm-up
        _ = Task.Delay(3500).ContinueWith(_ => RefreshStatusAsync());
    }

    // ── Menu ─────────────────────────────────────────────────────────────

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        _startItem = new ToolStripMenuItem("▶  Start Daemon", null, StartDaemon) { Enabled = false };
        _stopItem  = new ToolStripMenuItem("■  Stop Daemon",  null, StopDaemon)  { Enabled = false };
        _autoStartItem = new ToolStripMenuItem("🚀  Start on Login", null, ToggleAutoStart)
        {
            Checked = IsAutoStartEnabled(),
        };

        menu.Items.Add(_startItem);
        menu.Items.Add(_stopItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("⬛  Open TUI",       null, (_, _) => TerminalLauncher.Open("attache tui"));
        menu.Items.Add("💬  Quick Input…",   null, (_, _) => OpenQuickInput());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("ℹ  Status",          null, async (_, _) => await ShowStatusAsync());
        menu.Items.Add("🔄  Restart Daemon", null, async (_, _) => await RestartAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("⚙  Setup",           null, (_, _) => TerminalLauncher.Open("attache setup"));
        menu.Items.Add("⬆  Update",          null, (_, _) => TerminalLauncher.Open("attache update"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("✖  Exit",            null, ExitApp);

        return menu;
    }

    // ── Daemon lifecycle ─────────────────────────────────────────────────

    private void StartDaemon(object? sender, EventArgs e)
    {
        _daemon.Start();
        SetIcon(DaemonState.Starting);
        _trayIcon.ShowBalloonTip(3000, "Attache", "Daemon starting…", ToolTipIcon.Info);
        _ = Task.Delay(3500).ContinueWith(_ => RefreshStatusAsync());
    }

    private void StopDaemon(object? sender, EventArgs e)
    {
        _daemon.Stop();
        SetIcon(DaemonState.Stopped);
        _startItem.Enabled = true;
        _stopItem.Enabled = false;
        _trayIcon.Text = "Attache — daemon stopped";
        _trayIcon.ShowBalloonTip(2000, "Attache", "Daemon stopped.", ToolTipIcon.Info);
    }

    private async Task RestartAsync()
    {
        try
        {
            await _api.PostRestartAsync();
            SetIcon(DaemonState.Starting);
            _trayIcon.ShowBalloonTip(3000, "Attache", "Restarting…", ToolTipIcon.Info);
            await Task.Delay(4000);
            await RefreshStatusAsync();
        }
        catch
        {
            // Fallback: hard restart if API unreachable
            StopDaemon(null, EventArgs.Empty);
            await Task.Delay(1500);
            StartDaemon(null, EventArgs.Empty);
        }
    }

    // ── Status ────────────────────────────────────────────────────────────

    private async Task RefreshStatusAsync()
    {
        var result = await _api.GetStatusAsync();
        // Marshal back to the UI thread
        if (_trayIcon.ContextMenuStrip?.InvokeRequired == true)
            _trayIcon.ContextMenuStrip.Invoke(() => ApplyStatus(result));
        else
            ApplyStatus(result);
    }

    private void ApplyStatus(StatusResult result)
    {
        SetIcon(result.Running ? DaemonState.Running : DaemonState.Stopped);
        _trayIcon.Text = $"Attache — {result.Summary}";
        _startItem.Enabled = !result.Running;
        _stopItem.Enabled = result.Running;
    }

    private async Task ShowStatusAsync()
    {
        var result = await _api.GetStatusAsync();
        MessageBox.Show(
            result.Running
                ? $"✅ Daemon running\n{result.Summary}"
                : "⭕ Daemon is not running.\n\nUse \"Start Daemon\" from the tray menu.",
            "Attache Status",
            MessageBoxButtons.OK,
            result.Running ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    // ── Quick Input ───────────────────────────────────────────────────────

    private void OpenQuickInput()
    {
        if (_quickInputForm is { IsDisposed: false, Visible: true })
        {
            _quickInputForm.Activate();
            return;
        }
        _quickInputForm = new QuickInputForm(_api, _trayIcon);
        _quickInputForm.Show();
    }

    // ── Auto-start at login ───────────────────────────────────────────────

    private const string RunKeyPath  = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "AttacheShell";

    private static bool IsAutoStartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(RunValueName) is not null;
    }

    private void ToggleAutoStart(object? sender, EventArgs e)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true)!;
        if (IsAutoStartEnabled())
        {
            key.DeleteValue(RunValueName, throwOnMissingValue: false);
            _autoStartItem.Checked = false;
            _trayIcon.ShowBalloonTip(2000, "Attache", "Auto-start on login disabled.", ToolTipIcon.Info);
        }
        else
        {
            var exe = Process.GetCurrentProcess().MainModule?.FileName ?? "";
            key.SetValue(RunValueName, $"\"{exe}\"");
            _autoStartItem.Checked = true;
            _trayIcon.ShowBalloonTip(2000, "Attache", "Will start automatically at login.", ToolTipIcon.Info);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private void SetIcon(DaemonState state) =>
        _trayIcon.Icon = state switch
        {
            DaemonState.Running  => Icons.Green,
            DaemonState.Starting => Icons.Yellow,
            _                    => Icons.Grey,
        };

    private void ExitApp(object? sender, EventArgs e)
    {
        _statusTimer.Stop();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _statusTimer.Dispose();
            _api.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal enum DaemonState { Stopped, Starting, Running }
