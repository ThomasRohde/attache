using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace AttacheGui;

internal class SplashForm : Form
{
    private readonly System.Windows.Forms.Timer _fadeTimer = new() { Interval = 30 };
    private double _opacity = 1.0;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public SplashForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.FromArgb(24, 24, 28);
        Size = new Size(380, 400);
        DoubleBuffered = true;

        // Dark title bar for the brief moment the handle exists
        var useDark = 1;
        DwmSetWindowAttribute(Handle, 20, ref useDark, sizeof(int));

        _fadeTimer.Tick += OnFadeTick;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        // Draw the icon centered, at 200x200, recolored white for dark background
        try
        {
            var iconPath = Path.Combine(AppContext.BaseDirectory, "wwwroot", "icon.png");
            if (File.Exists(iconPath))
            {
                using var img = Image.FromFile(iconPath);
                int size = 200;
                int x = (Width - size) / 2;
                int y = 40;

                // Invert RGB so black icon renders white; preserve alpha
                var cm = new ColorMatrix(new[]
                {
                    new float[] { -1,  0,  0, 0, 0 },
                    new float[] {  0, -1,  0, 0, 0 },
                    new float[] {  0,  0, -1, 0, 0 },
                    new float[] {  0,  0,  0, 1, 0 },
                    new float[] {  1,  1,  1, 0, 1 },
                });
                using var attrs = new ImageAttributes();
                attrs.SetColorMatrix(cm);
                g.DrawImage(img,
                    new Rectangle(x, y, size, size),
                    0, 0, img.Width, img.Height,
                    GraphicsUnit.Pixel, attrs);
            }
        }
        catch { /* best effort */ }

        // App name
        using var nameFont = new Font("Segoe UI", 24f, FontStyle.Bold);
        using var nameBrush = new SolidBrush(Color.White);
        var nameFormat = new StringFormat { Alignment = StringAlignment.Center };
        g.DrawString("Attache", nameFont, nameBrush, Width / 2f, 260, nameFormat);

        // Subtitle
        using var subFont = new Font("Segoe UI", 10f);
        using var subBrush = new SolidBrush(Color.FromArgb(156, 163, 175));
        g.DrawString("AI Assistant Daemon", subFont, subBrush, Width / 2f, 305, nameFormat);

        // Loading dots
        using var dotBrush = new SolidBrush(Color.FromArgb(0, 122, 204));
        int dotY = 350;
        int dotSize = 8;
        int gap = 16;
        int totalWidth = 3 * dotSize + 2 * gap;
        int startX = (Width - totalWidth) / 2;
        for (int i = 0; i < 3; i++)
        {
            g.FillEllipse(dotBrush, startX + i * (dotSize + gap), dotY, dotSize, dotSize);
        }
    }

    public void BeginFadeOut()
    {
        _fadeTimer.Start();
    }

    private void OnFadeTick(object? sender, EventArgs e)
    {
        _opacity -= 0.08;
        if (_opacity <= 0)
        {
            _fadeTimer.Stop();
            Close();
            return;
        }
        Opacity = _opacity;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _fadeTimer.Dispose();
        base.Dispose(disposing);
    }

    // Rounded corners via region
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        using var path = new GraphicsPath();
        int radius = 16;
        var rect = new Rectangle(0, 0, Width, Height);
        path.AddArc(rect.X, rect.Y, radius, radius, 180, 90);
        path.AddArc(rect.Right - radius, rect.Y, radius, radius, 270, 90);
        path.AddArc(rect.Right - radius, rect.Bottom - radius, radius, radius, 0, 90);
        path.AddArc(rect.X, rect.Bottom - radius, radius, radius, 90, 90);
        path.CloseFigure();
        Region = new Region(path);
    }
}
