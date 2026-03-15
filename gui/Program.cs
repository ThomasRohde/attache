using System.Windows.Forms;

namespace AttacheGui;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);

        using var mutex = new Mutex(true, "AttacheGuiSingleInstance", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show(
                "Attache is already running.",
                "Attache",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        Application.Run(new MainForm());
    }
}
