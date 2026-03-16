using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.AspNetCore.Components.WebView.WindowsForms;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Win32;
using AttacheGui.Services;

namespace AttacheGui;

public partial class MainForm : Form
{
    private readonly BlazorWebView _blazorWebView;
    private readonly NotifyIcon _trayIcon;
    private readonly DaemonManager _daemon = new();
    private readonly System.Windows.Forms.Timer _statusTimer = new() { Interval = 30_000 };

    private ToolStripMenuItem _startItem = null!;
    private ToolStripMenuItem _stopItem = null!;
    private ToolStripMenuItem _autoStartItem = null!;

    private DaemonState _daemonState = DaemonState.Stopped;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public MainForm()
    {
        Text = "Attache";
        var workArea = Screen.PrimaryScreen!.WorkingArea;
        Width = Math.Max(1280, (int)(workArea.Width * 0.8));
        Height = Math.Max(800, (int)(workArea.Height * 0.8));
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = IsSystemDarkMode() ? Color.FromArgb(30, 30, 30) : Color.White;
        Icon = Icons.CreateAppIcon();

        // Match title bar to system theme (DWMWA_USE_IMMERSIVE_DARK_MODE = 20)
        var useDark = IsSystemDarkMode() ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20, ref useDark, sizeof(int));

        // --- DI & Blazor ---
        var services = new ServiceCollection();
        services.AddWindowsFormsBlazorWebView();
        services.AddSingleton<ApiClient>();
        services.AddSingleton<SseService>();
        services.AddSingleton<DaemonManager>(_daemon);
        services.AddSingleton<AppState>();
        services.AddSingleton<MarkdownService>();

        _blazorWebView = new BlazorWebView
        {
            Dock = DockStyle.Fill,
            HostPage = "wwwroot\\index.html",
            Services = services.BuildServiceProvider(),
        };
        _blazorWebView.RootComponents.Add<Components.Layout.MainLayout>("#app");
        Controls.Add(_blazorWebView);

        // --- Tray icon ---
        _trayIcon = new NotifyIcon
        {
            Icon = Icons.Grey,
            Text = "Attache — starting...",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _trayIcon.DoubleClick += (_, _) => ShowWindow();

        _statusTimer.Tick += async (_, _) => await RefreshStatusAsync();
        _statusTimer.Start();

        // Auto-start daemon
        _daemon.Start();
        SetDaemonState(DaemonState.Starting);
        _ = Task.Delay(3500).ContinueWith(_ => RefreshStatusAsync());
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    // ── Menu ──────────────────────────────────────────────────────

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        _startItem = new ToolStripMenuItem("Start Daemon", null, StartDaemon) { Enabled = false };
        _stopItem = new ToolStripMenuItem("Stop Daemon", null, StopDaemon) { Enabled = false };
        _autoStartItem = new ToolStripMenuItem("Start on Login", null, ToggleAutoStart)
        {
            Checked = IsAutoStartEnabled(),
        };

        menu.Items.Add(_startItem);
        menu.Items.Add(_stopItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Show Window", null, (_, _) => ShowWindow());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart Daemon", null, async (_, _) => await RestartAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, ExitApp);

        return menu;
    }

    // ── Daemon lifecycle ──────────────────────────────────────────

    private void StartDaemon(object? sender, EventArgs e)
    {
        _daemon.Start();
        SetDaemonState(DaemonState.Starting);
        _trayIcon.ShowBalloonTip(3000, "Attache", "Daemon starting...", ToolTipIcon.Info);
        _ = Task.Delay(3500).ContinueWith(_ => RefreshStatusAsync());
    }

    private void StopDaemon(object? sender, EventArgs e)
    {
        _daemon.Stop();
        SetDaemonState(DaemonState.Stopped);
        _trayIcon.Text = "Attache — daemon stopped";
        _trayIcon.ShowBalloonTip(2000, "Attache", "Daemon stopped.", ToolTipIcon.Info);
    }

    private async Task RestartAsync()
    {
        var api = _blazorWebView.Services.GetRequiredService<ApiClient>();
        try
        {
            await api.PostRestartAsync();
            SetDaemonState(DaemonState.Starting);
            _trayIcon.ShowBalloonTip(3000, "Attache", "Restarting...", ToolTipIcon.Info);
            await Task.Delay(4000);
            await RefreshStatusAsync();
        }
        catch
        {
            StopDaemon(null, EventArgs.Empty);
            await Task.Delay(1500);
            StartDaemon(null, EventArgs.Empty);
        }
    }

    // ── Status ───────────────────────────────────────────────────

    private async Task RefreshStatusAsync()
    {
        var api = _blazorWebView.Services.GetRequiredService<ApiClient>();
        var result = await api.GetStatusAsync();
        if (InvokeRequired)
            Invoke(() => ApplyStatus(result));
        else
            ApplyStatus(result);
    }

    private void ApplyStatus(StatusResult result)
    {
        SetDaemonState(result.Running ? DaemonState.Running : DaemonState.Stopped);
        _trayIcon.Text = $"Attache — {result.Summary}";
        _startItem.Enabled = !result.Running;
        _stopItem.Enabled = result.Running;
    }

    private void SetDaemonState(DaemonState state)
    {
        _daemonState = state;
        _trayIcon.Icon = state switch
        {
            DaemonState.Running => Icons.Green,
            DaemonState.Starting => Icons.Yellow,
            _ => Icons.Grey,
        };
    }

    // ── Theme ─────────────────────────────────────────────────────

    private static bool IsSystemDarkMode()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
    }

    // ── Auto-start ───────────────────────────────────────────────

    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValueName = "AttacheGui";

    private static bool IsAutoStartEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(RunValueName) is not null;
    }

    private void ToggleAutoStart(object? sender, EventArgs e)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        if (key is null) return;
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

    // ── Cleanup ──────────────────────────────────────────────────

    private void ExitApp(object? sender, EventArgs e)
    {
        _statusTimer.Stop();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        FormClosing -= null!; // allow actual close
        Application.Exit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            _trayIcon.ShowBalloonTip(2000, "Attache", "Still running in system tray.", ToolTipIcon.Info);
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _statusTimer.Dispose();
            _trayIcon.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal enum DaemonState { Stopped, Starting, Running }

internal static class Icons
{
    private static Icon? _green;
    private static Icon? _grey;
    private static Icon? _yellow;

    public static Icon Green => _green ??= CreateCircleIcon(Color.FromArgb(34, 197, 94));
    public static Icon Grey => _grey ??= CreateCircleIcon(Color.FromArgb(156, 163, 175));
    public static Icon Yellow => _yellow ??= CreateCircleIcon(Color.FromArgb(234, 179, 8));

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private static Icon CreateCircleIcon(Color color)
    {
        using var bmp = new Bitmap(16, 16, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, 2, 2, 12, 12);
        var hIcon = bmp.GetHicon();
        var icon = (Icon)Icon.FromHandle(hIcon).Clone();
        DestroyIcon(hIcon);
        return icon;
    }

    public static Icon CreateAppIcon()
    {
        using var bmp = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var brush = new SolidBrush(Color.FromArgb(0, 122, 204));
        g.FillEllipse(brush, 2, 2, 28, 28);
        using var font = new Font("Segoe UI", 14f, FontStyle.Bold);
        using var textBrush = new SolidBrush(Color.White);
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString("A", font, textBrush, new RectangleF(0, 0, 32, 32), sf);
        var hIcon = bmp.GetHicon();
        var icon = (Icon)Icon.FromHandle(hIcon).Clone();
        DestroyIcon(hIcon);
        return icon;
    }
}

