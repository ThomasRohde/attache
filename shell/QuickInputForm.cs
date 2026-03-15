using System.Drawing;
using System.Text.Json;
using System.Windows.Forms;

namespace AttacheShell;

public class QuickInputForm : Form
{
    private readonly ApiClient _api;
    private readonly NotifyIcon _trayIcon;
    private readonly CancellationTokenSource _cts = new();

    private string? _connectionId;
    private StreamReader? _sseReader;

    private readonly TextBox _inputBox;
    private readonly Button _sendButton;
    private readonly RichTextBox _responseBox;
    private readonly Button _copyButton;
    private readonly Label _statusLabel;

    public QuickInputForm(ApiClient api, NotifyIcon trayIcon)
    {
        _api = api;
        _trayIcon = trayIcon;

        // Form chrome
        Text = "Attache";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        Width = 480;
        Height = 320;
        BackColor = Color.FromArgb(30, 30, 30);
        ForeColor = Color.FromArgb(220, 220, 220);
        Font = new Font("Segoe UI", 10f);

        // Position near tray (bottom-right of working area)
        var screen = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        Location = new Point(screen.Right - Width - 12, screen.Bottom - Height - 12);

        // Input row
        _inputBox = new TextBox
        {
            PlaceholderText = "Ask Attache something…",
            Location = new Point(12, 12),
            Width = 358,
            Height = 28,
            BackColor = Color.FromArgb(45, 45, 48),
            ForeColor = Color.FromArgb(220, 220, 220),
            BorderStyle = BorderStyle.FixedSingle,
            Enabled = false,
        };
        _inputBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _ = SendPromptAsync(); }
        };

        _sendButton = new Button
        {
            Text = "Send",
            Location = new Point(378, 12),
            Width = 82,
            Height = 28,
            BackColor = Color.FromArgb(0, 122, 204),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Enabled = false,
        };
        _sendButton.FlatAppearance.BorderSize = 0;
        _sendButton.Click += (_, _) => _ = SendPromptAsync();

        // Status line
        _statusLabel = new Label
        {
            Text = "Connecting…",
            Location = new Point(12, 46),
            Width = 448,
            Height = 18,
            ForeColor = Color.FromArgb(120, 120, 120),
            Font = new Font("Segoe UI", 8.5f),
        };

        // Response area
        _responseBox = new RichTextBox
        {
            ReadOnly = true,
            Location = new Point(12, 68),
            Width = 448,
            Height = 196,
            BackColor = Color.FromArgb(20, 20, 20),
            ForeColor = Color.FromArgb(200, 200, 200),
            BorderStyle = BorderStyle.None,
            ScrollBars = RichTextBoxScrollBars.Vertical,
            WordWrap = true,
        };

        _copyButton = new Button
        {
            Text = "Copy",
            Location = new Point(380, 272),
            Width = 80,
            Height = 26,
            BackColor = Color.FromArgb(60, 60, 60),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
        };
        _copyButton.FlatAppearance.BorderSize = 0;
        _copyButton.Click += (_, _) =>
        {
            if (!string.IsNullOrEmpty(_responseBox.Text))
                Clipboard.SetText(_responseBox.Text);
        };

        Controls.AddRange([_inputBox, _sendButton, _statusLabel, _responseBox, _copyButton]);

        KeyPreview = true;
        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) Close(); };

        Load += async (_, _) => await ConnectSseAsync();
    }

    private async Task ConnectSseAsync()
    {
        const int maxAttempts = 12;
        const int retryDelayMs = 3000;

        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            if (_cts.Token.IsCancellationRequested) return;

            try
            {
                SetStatus(attempt == 1
                    ? "Connecting to daemon…"
                    : $"Retrying connection… ({attempt}/{maxAttempts})");

                var (connectionId, reader) = await _api.OpenSseConnectionAsync(_cts.Token);
                _connectionId = connectionId;
                _sseReader = reader;

                SetStatus("Ready — type a prompt and press Enter");
                _inputBox.Enabled = true;
                _sendButton.Enabled = true;
                _inputBox.Focus();
                return;
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex) when (attempt < maxAttempts)
            {
                var reason = ex is HttpRequestException { StatusCode: System.Net.HttpStatusCode.Unauthorized }
                    ? "waiting for daemon auth…"
                    : "daemon not ready yet…";
                SetStatus($"{reason} retrying in {retryDelayMs / 1000}s");
                try { await Task.Delay(retryDelayMs, _cts.Token); }
                catch (OperationCanceledException) { return; }
            }
            catch (Exception ex)
            {
                SetStatus($"Could not connect: {ex.Message}");
                _trayIcon.ShowBalloonTip(
                    4000, "Attache",
                    "Quick Input could not connect. Is the daemon running?",
                    ToolTipIcon.Warning);
                return;
            }
        }
    }

    private async Task SendPromptAsync()
    {
        var prompt = _inputBox.Text.Trim();
        if (string.IsNullOrEmpty(prompt) || _connectionId is null || _sseReader is null) return;

        _inputBox.Clear();
        _inputBox.Enabled = false;
        _sendButton.Enabled = false;
        _responseBox.Clear();
        SetStatus("Sending…");

        try
        {
            var ok = await _api.SendMessageAsync(prompt, _connectionId);
            if (!ok)
            {
                SetStatus("Failed to send. Is the daemon still running?");
                return;
            }

            SetStatus("Waiting for response…");

            // Read SSE events from the shared reader until complete or cancelled.
            // ReadLineAsync returns null at end-of-stream; loop until that or a terminal event.
            while (true)
            {
                var line = await _sseReader.ReadLineAsync(_cts.Token);
                if (line is null) break;
                if (!line.StartsWith("data:")) continue;

                var dataJson = line["data:".Length..].Trim();
                try
                {
                    using var doc = JsonDocument.Parse(dataJson);
                    var type = doc.RootElement.TryGetProperty("type", out var t)
                        ? t.GetString() : null;

                    if (type == "delta")
                    {
                        var content = doc.RootElement.TryGetProperty("content", out var c)
                            ? c.GetString() ?? "" : "";
                        AppendResponse(content);
                    }
                    else if (type == "message")
                    {
                        // Complete event — replace with final text
                        var content = doc.RootElement.TryGetProperty("content", out var c)
                            ? c.GetString() ?? "" : "";
                        SetResponseText(content);
                        SetStatus("Done.");
                        break;
                    }
                    else if (type == "cancelled")
                    {
                        SetStatus("Cancelled.");
                        break;
                    }
                }
                catch { /* skip malformed SSE lines */ }
            }
        }
        catch (OperationCanceledException)
        {
            SetStatus("Disconnected.");
        }
        catch (Exception ex)
        {
            SetStatus($"Error: {ex.Message}");
        }
        finally
        {
            if (!IsDisposed)
            {
                _inputBox.Enabled = true;
                _sendButton.Enabled = true;
                _inputBox.Focus();
            }
        }
    }

    private void SetStatus(string text)
    {
        if (InvokeRequired) { Invoke(() => SetStatus(text)); return; }
        _statusLabel.Text = text;
    }

    private void AppendResponse(string text)
    {
        if (InvokeRequired) { Invoke(() => AppendResponse(text)); return; }
        _responseBox.AppendText(text);
        _responseBox.ScrollToCaret();
    }

    private void SetResponseText(string text)
    {
        if (InvokeRequired) { Invoke(() => SetResponseText(text)); return; }
        _responseBox.Text = text;
        _responseBox.ScrollToCaret();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _cts.Cancel();
        _sseReader?.Dispose();
        base.OnFormClosed(e);
    }
}
