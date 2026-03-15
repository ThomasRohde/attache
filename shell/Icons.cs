using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace AttacheShell;

public static class Icons
{
    private static Icon? _green;
    private static Icon? _grey;
    private static Icon? _yellow;

    public static Icon Green  => _green  ??= CreateCircleIcon(Color.FromArgb(34, 197, 94));
    public static Icon Grey   => _grey   ??= CreateCircleIcon(Color.FromArgb(156, 163, 175));
    public static Icon Yellow => _yellow ??= CreateCircleIcon(Color.FromArgb(234, 179, 8));

    private static Icon CreateCircleIcon(Color color)
    {
        using var bmp = new Bitmap(16, 16, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, 2, 2, 12, 12);
        return Icon.FromHandle(bmp.GetHicon());
    }
}
