using System.Windows.Forms;

Application.EnableVisualStyles();
Application.SetCompatibleTextRenderingDefault(false);

using var mutex = new Mutex(true, "AttacheShellSingleInstance", out var createdNew);
if (!createdNew)
{
    MessageBox.Show(
        "Attache Shell is already running in the system tray.",
        "Attache",
        MessageBoxButtons.OK,
        MessageBoxIcon.Information);
    return;
}

Application.Run(new AttacheShell.TrayApplicationContext());
