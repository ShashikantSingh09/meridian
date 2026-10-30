# A small white window with known text, so screen checks never read real content.
param([string]$Title = "Meridian OCR target", [string]$Text = "terraform plan|Error: Invalid reference|on main.tf line 12", [int]$Seconds = 25, [switch]$TopMost)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Windows lets a process take the foreground just after a key press.
  public static void Take(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }
}
"@
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.BackColor = [System.Drawing.Color]::White
$form.StartPosition = "Manual"
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.Location = New-Object System.Drawing.Point ([int](($screen.Width - 700) / 2)), 0
$form.Size = New-Object System.Drawing.Size 700, 320
$label = New-Object System.Windows.Forms.Label
$label.Text = $Text.Replace("|", "`n")
$label.Font = New-Object System.Drawing.Font "Consolas", 20
$label.ForeColor = [System.Drawing.Color]::Black
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point 30, 90
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Seconds * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
# On top without taking focus, so a test never interrupts what you are doing.
if ($TopMost) { $form.TopMost = $true } else { $form.Add_Shown({ [Fg]::Take($form.Handle) }) }
[System.Windows.Forms.Application]::Run($form)
